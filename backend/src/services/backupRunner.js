/**
 * backupRunner.js -- Orchestrates Genizah backup runs
 * Scans for unsynced attachments, uploads to Drive, snapshots DB,
 * records results in backup_runs and activity_log.
 */

const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { google } = require('googleapis');
const { getDb } = require('../models/database');
const {
  getOAuth2Client, findOrCreateFolders, uploadFile,
  uploadDbSnapshot, hashFile, checkGoogleAuth, formatBytes
} = require('./driveBackup');

let backupInProgress = false;

/**
 * Run DB migrations for backup tables. Safe to call multiple times.
 */
function runMigrations() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      files_synced INTEGER DEFAULT 0,
      files_failed INTEGER DEFAULT 0,
      files_skipped INTEGER DEFAULT 0,
      db_backed_up INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS drive_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attachment_id INTEGER NOT NULL,
      drive_file_id TEXT,
      drive_folder_id TEXT,
      last_synced_at TEXT,
      status TEXT DEFAULT 'pending',
      file_hash TEXT,
      error_message TEXT,
      UNIQUE(attachment_id)
    );
  `);
}

/**
 * Main backup function. Uploads all unsynced/changed attachments
 * and a DB snapshot to Google Drive.
 */
async function runBackup() {
  if (backupInProgress) {
    throw new Error('A backup is already in progress.');
  }

  backupInProgress = true;
  const db = getDb();

  // Ensure tables exist
  runMigrations();

  const run = db.prepare(
    `INSERT INTO backup_runs (started_at, status) VALUES (datetime('now'), 'running')`
  ).run();
  const runId = run.lastInsertRowid;

  let filesSynced = 0, filesFailed = 0, filesSkipped = 0, totalBytes = 0, dbBackedUp = 0;

  try {
    const authCheck = checkGoogleAuth();
    if (!authCheck.ok) throw new Error(`Google auth error: ${authCheck.error}`);

    const oauth2Client = getOAuth2Client();
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folders = await findOrCreateFolders(drive);

    // Get all attachments
    const attachments = db.prepare(`
      SELECT id, file_path, original_name, document_id
      FROM document_attachments ORDER BY id
    `).all();

    console.log(`[BackupRunner] Found ${attachments.length} total attachments`);

    const uploadDir = process.env.UPLOAD_PATH || '/app/data/files';

    for (const att of attachments) {
      try {
        const localPath = path.join(uploadDir, att.file_path);

        if (!fs.existsSync(localPath)) {
          console.warn(`[BackupRunner] Missing on disk: ${att.file_path}`);
          filesSkipped++;
          continue;
        }

        const currentHash = hashFile(localPath);
        const fileSize = fs.statSync(localPath).size;

        // Check drive_sync
        const syncRecord = db.prepare(
          `SELECT id, file_hash, status FROM drive_sync WHERE attachment_id = ?`
        ).get(att.id);

        if (syncRecord && syncRecord.file_hash === currentHash && syncRecord.status === 'synced') {
          filesSkipped++;
          continue;
        }

        // Upload
        const driveFileId = await uploadFile(
          drive, localPath, att.file_path, String(att.id), folders.files
        );

        // Upsert drive_sync
        db.prepare(`
          INSERT INTO drive_sync (attachment_id, drive_file_id, drive_folder_id, last_synced_at, status, file_hash, error_message)
          VALUES (?, ?, ?, datetime('now'), 'synced', ?, NULL)
          ON CONFLICT(attachment_id) DO UPDATE SET
            drive_file_id = excluded.drive_file_id,
            drive_folder_id = excluded.drive_folder_id,
            last_synced_at = excluded.last_synced_at,
            status = excluded.status,
            file_hash = excluded.file_hash,
            error_message = NULL
        `).run(att.id, driveFileId, folders.files, currentHash);

        filesSynced++;
        totalBytes += fileSize;

      } catch (fileErr) {
        console.error(`[BackupRunner] Failed attachment ${att.id}:`, fileErr.message);
        db.prepare(`
          INSERT INTO drive_sync (attachment_id, status, error_message)
          VALUES (?, 'failed', ?)
          ON CONFLICT(attachment_id) DO UPDATE SET
            status = 'failed', error_message = excluded.error_message
        `).run(att.id, fileErr.message);
        filesFailed++;
      }
    }

    // DB snapshot
    try {
      const dbResult = await uploadDbSnapshot(drive, folders.db);
      dbBackedUp = 1;
      totalBytes += dbResult.size;
    } catch (dbErr) {
      console.error('[BackupRunner] DB snapshot failed:', dbErr.message);
    }

    const status = filesFailed > 0 ? 'partial' : 'success';

    db.prepare(`
      UPDATE backup_runs SET completed_at = datetime('now'),
        files_synced = ?, files_failed = ?, files_skipped = ?,
        db_backed_up = ?, total_bytes = ?, status = ?
      WHERE id = ?
    `).run(filesSynced, filesFailed, filesSkipped, dbBackedUp, totalBytes, status, runId);

    // Activity log
    const summary = `Backup ${status}: ${filesSynced} synced, ${filesSkipped} unchanged, ${filesFailed} failed, DB ${dbBackedUp ? 'saved' : 'skipped'} (${formatBytes(totalBytes)})`;
    db.prepare(
      `INSERT INTO activity_log (action, details, created_at) VALUES ('backup_complete', ?, datetime('now'))`
    ).run(summary);

    // Also update the sync_status table so the dashboard health badge works
    db.prepare(`
      INSERT INTO sync_status (sync_type, status, file_count, total_size_bytes, started_at)
      VALUES ('gdrive', ?, ?, ?, datetime('now'))
    `).run(status, filesSynced, totalBytes);

    console.log(`[BackupRunner] ${summary}`);
    return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(runId);

  } catch (err) {
    console.error('[BackupRunner] Backup failed:', err.message);

    db.prepare(`
      UPDATE backup_runs SET completed_at = datetime('now'),
        files_synced = ?, files_failed = ?, files_skipped = ?,
        db_backed_up = ?, total_bytes = ?, status = 'failed', error_message = ?
      WHERE id = ?
    `).run(filesSynced, filesFailed, filesSkipped, dbBackedUp, totalBytes, err.message, runId);

    db.prepare(
      `INSERT INTO activity_log (action, details, created_at) VALUES ('backup_failed', ?, datetime('now'))`
    ).run(`Backup failed: ${err.message}`);

    return db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(runId);

  } finally {
    backupInProgress = false;
  }
}

/** Get current backup status summary. */
function getBackupStatus() {
  const db = getDb();
  runMigrations();

  const lastRun = db.prepare(
    `SELECT * FROM backup_runs ORDER BY id DESC LIMIT 1`
  ).get();

  const pendingCount = db.prepare(`
    SELECT COUNT(*) as count FROM document_attachments
    WHERE id NOT IN (SELECT attachment_id FROM drive_sync WHERE status = 'synced')
  `).get();

  const syncedCount = db.prepare(
    `SELECT COUNT(*) as count FROM drive_sync WHERE status = 'synced'`
  ).get();

  const failedCount = db.prepare(
    `SELECT COUNT(*) as count FROM drive_sync WHERE status = 'failed'`
  ).get();

  const totalSize = db.prepare(
    `SELECT COALESCE(SUM(total_bytes), 0) as total FROM backup_runs WHERE status IN ('success', 'partial')`
  ).get();

  const authCheck = checkGoogleAuth();

  return {
    last_run: lastRun || null,
    files_pending: pendingCount.count,
    files_synced: syncedCount.count,
    files_failed: failedCount.count,
    total_backed_up_bytes: totalSize.total,
    google_auth_ok: authCheck.ok,
    google_auth_error: authCheck.error || null,
    backup_in_progress: backupInProgress,
    cron_schedule: process.env.BACKUP_CRON || '0 2 * * *'
  };
}

/** Get recent backup run history. */
function getBackupHistory(limit = 20) {
  const db = getDb();
  runMigrations();
  return db.prepare(`SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?`).all(limit);
}

/** Initialize the cron scheduler for nightly backups. */
function initBackupScheduler() {
  const schedule = process.env.BACKUP_CRON || '0 2 * * *';

  runMigrations();

  if (!cron.validate(schedule)) {
    console.error(`[BackupRunner] Invalid BACKUP_CRON: "${schedule}", using default`);
    return startSchedule('0 2 * * *');
  }

  return startSchedule(schedule);
}

function startSchedule(schedule) {
  const authCheck = checkGoogleAuth();
  if (!authCheck.ok) {
    console.warn(`[BackupRunner] Google auth not ready: ${authCheck.error}. Backups will fail until auth is fixed.`);
  } else {
    console.log('[BackupRunner] Google auth verified');
  }

  const task = cron.schedule(schedule, async () => {
    console.log(`[BackupRunner] Scheduled backup starting at ${new Date().toISOString()}`);
    try {
      await runBackup();
    } catch (err) {
      console.error('[BackupRunner] Scheduled backup error:', err.message);
    }
  }, {
    timezone: 'America/Chicago'
  });

  console.log(`[BackupRunner] Scheduler initialized: "${schedule}"`);
  return task;
}

function isBackupRunning() {
  return backupInProgress;
}

module.exports = {
  runBackup, getBackupStatus, getBackupHistory,
  initBackupScheduler, isBackupRunning, runMigrations
};
