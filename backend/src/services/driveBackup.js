/**
 * driveBackup.js -- Google Drive API wrapper for Genizah backup
 * Uses admin user's OAuth tokens (drive.file scope) to upload
 * documents and DB snapshots to a dedicated Drive folder.
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDb } = require('../models/database');

// Cache the Drive folder IDs in memory so we don't re-query every run
let folderCache = { root: null, files: null, db: null };

/**
 * Build an OAuth2 client from the admin user's stored tokens.
 * Automatically refreshes expired access tokens and saves them back to the DB.
 */
function getOAuth2Client() {
  const db = getDb();

  const admin = db.prepare(`
    SELECT id, google_access_token, google_refresh_token, google_token_expires, google_scopes
    FROM users WHERE role = 'admin' AND google_refresh_token IS NOT NULL
    LIMIT 1
  `).get();

  if (!admin) {
    throw new Error('No admin user with Google credentials found. Link Google in Settings first.');
  }

  if (!admin.google_scopes || !admin.google_scopes.includes('drive.file')) {
    throw new Error('Admin user does not have drive.file scope. Re-link Google with Drive permissions.');
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: admin.google_access_token,
    refresh_token: admin.google_refresh_token,
    expiry_date: admin.google_token_expires ? Number(admin.google_token_expires) : null
  });

  // When tokens refresh, save the new ones back to the database
  oauth2Client.on('tokens', (tokens) => {
    const fields = [];
    const values = [];

    if (tokens.access_token) { fields.push('google_access_token = ?'); values.push(tokens.access_token); }
    if (tokens.refresh_token) { fields.push('google_refresh_token = ?'); values.push(tokens.refresh_token); }
    if (tokens.expiry_date) { fields.push('google_token_expires = ?'); values.push(tokens.expiry_date); }

    if (fields.length > 0) {
      values.push(admin.id);
      db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      console.log('[DriveBackup] Refreshed and saved new Google tokens');
    }
  });

  return oauth2Client;
}

/**
 * Find or create the "Genizah Backups" folder structure in Drive.
 * Structure: Genizah Backups / files / ... , Genizah Backups / db / ...
 * Uses appProperties to tag our folder so we can find it reliably.
 */
async function findOrCreateFolders(drive) {
  if (folderCache.root && folderCache.files && folderCache.db) {
    // Verify root still exists (user might have deleted it)
    try {
      const check = await drive.files.get({ fileId: folderCache.root, fields: 'id,trashed' });
      if (!check.data.trashed) return folderCache;
    } catch {
      // Folder gone, reset cache
    }
    folderCache = { root: null, files: null, db: null };
  }

  // Search for existing root folder by appProperties
  const searchRes = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and appProperties has { key='genizah' and value='backup-root' } and trashed=false",
    fields: 'files(id,name)',
    spaces: 'drive'
  });

  let rootId;
  if (searchRes.data.files && searchRes.data.files.length > 0) {
    rootId = searchRes.data.files[0].id;
    console.log('[DriveBackup] Found existing Genizah Backups folder:', rootId);
  } else {
    const createRes = await drive.files.create({
      requestBody: {
        name: 'Genizah Backups',
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { genizah: 'backup-root' }
      },
      fields: 'id'
    });
    rootId = createRes.data.id;
    console.log('[DriveBackup] Created Genizah Backups folder:', rootId);
  }

  const filesId = await findOrCreateSubfolder(drive, rootId, 'files', 'backup-files');
  const dbId = await findOrCreateSubfolder(drive, rootId, 'db', 'backup-db');

  folderCache = { root: rootId, files: filesId, db: dbId };
  return folderCache;
}

async function findOrCreateSubfolder(drive, parentId, name, tag) {
  const res = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and appProperties has { key='genizah' and value='${tag}' } and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive'
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const createRes = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
      appProperties: { genizah: tag }
    },
    fields: 'id'
  });

  console.log(`[DriveBackup] Created "${name}" subfolder:`, createRes.data.id);
  return createRes.data.id;
}

/**
 * Upload a single file to the "files" folder in Drive.
 * If a file with the same appProperties.attachment_id exists, update it.
 */
async function uploadFile(drive, localPath, fileName, attachmentId, folderId) {
  const fileSize = fs.statSync(localPath).size;
  const mimeType = getMimeType(fileName);

  // Check if this attachment already has a Drive file
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and appProperties has { key='attachment_id' and value='${attachmentId}' } and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive'
  });

  const media = { mimeType, body: fs.createReadStream(localPath) };
  let driveFileId;

  if (existing.data.files && existing.data.files.length > 0) {
    driveFileId = existing.data.files[0].id;
    await drive.files.update({ fileId: driveFileId, media, fields: 'id' });
    console.log(`[DriveBackup] Updated: ${fileName} (${formatBytes(fileSize)})`);
  } else {
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
        appProperties: { attachment_id: String(attachmentId) }
      },
      media,
      fields: 'id'
    });
    driveFileId = res.data.id;
    console.log(`[DriveBackup] Uploaded: ${fileName} (${formatBytes(fileSize)})`);
  }

  return driveFileId;
}

/**
 * Create a safe copy of the SQLite DB and upload it to the "db" folder.
 * Keeps the last 7 snapshots.
 */
async function uploadDbSnapshot(drive, dbFolderId) {
  const dbPath = process.env.DB_PATH || '/app/data/db/genizah.sqlite';
  const today = new Date().toISOString().split('T')[0];
  const snapshotName = `genizah-${today}.sqlite`;
  const tmpPath = path.join('/tmp', snapshotName);

  // Safe copy (WAL checkpoint happens on read)
  fs.copyFileSync(dbPath, tmpPath);
  const fileSize = fs.statSync(tmpPath).size;

  // Check if today's snapshot already exists
  const existing = await drive.files.list({
    q: `'${dbFolderId}' in parents and name='${snapshotName}' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive'
  });

  const media = { mimeType: 'application/x-sqlite3', body: fs.createReadStream(tmpPath) };
  let driveFileId;

  if (existing.data.files && existing.data.files.length > 0) {
    driveFileId = existing.data.files[0].id;
    await drive.files.update({ fileId: driveFileId, media, fields: 'id' });
  } else {
    const res = await drive.files.create({
      requestBody: { name: snapshotName, parents: [dbFolderId] },
      media,
      fields: 'id'
    });
    driveFileId = res.data.id;
  }

  // Clean up temp file
  try { fs.unlinkSync(tmpPath); } catch {}

  // Prune: keep last 7
  await pruneOldSnapshots(drive, dbFolderId, 7);

  console.log(`[DriveBackup] DB snapshot: ${snapshotName} (${formatBytes(fileSize)})`);
  return { driveFileId, size: fileSize };
}

async function pruneOldSnapshots(drive, dbFolderId, keep) {
  const res = await drive.files.list({
    q: `'${dbFolderId}' in parents and name contains 'genizah-' and trashed=false`,
    fields: 'files(id,name,createdTime)',
    orderBy: 'createdTime desc',
    spaces: 'drive'
  });

  const files = res.data.files || [];
  if (files.length <= keep) return;

  for (const file of files.slice(keep)) {
    await drive.files.delete({ fileId: file.id });
    console.log(`[DriveBackup] Pruned: ${file.name}`);
  }
}

/** Compute SHA-256 hash of a file for change detection. */
function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Check if admin has valid Google auth with drive.file scope. */
function checkGoogleAuth() {
  try {
    const db = getDb();
    const admin = db.prepare(`
      SELECT google_refresh_token, google_scopes
      FROM users WHERE role = 'admin' AND google_refresh_token IS NOT NULL
      LIMIT 1
    `).get();

    if (!admin) return { ok: false, error: 'No admin with Google credentials' };
    if (!admin.google_scopes || !admin.google_scopes.includes('drive.file')) {
      return { ok: false, error: 'Missing drive.file scope' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.heic': 'image/heic', '.heif': 'image/heif',
    '.tiff': 'image/tiff', '.tif': 'image/tiff', '.bmp': 'image/bmp'
  };
  return map[ext] || 'application/octet-stream';
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

module.exports = {
  getOAuth2Client, findOrCreateFolders, uploadFile,
  uploadDbSnapshot, hashFile, checkGoogleAuth, formatBytes
};
