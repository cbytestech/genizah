// Gmail Receipt Scanner Service
// Scans linked Gmail accounts for receipts, invoices, warranties, manuals
// Creates Genizah documents automatically with OCR and parsed metadata
//
// Schema reference (all PKs are TEXT UUIDs):
//   documents:            id, title, type_id, uploaded_by, file_path (NOT NULL), vendor, amount, document_date, notes, ocr_text, ...
//   document_attachments: id, document_id, file_path, original_filename, mime_type, file_size, sort_order
//   document_owners:      document_id, owner_id (refs owners.id, NOT users.id)
//   document_tags:        document_id, tag_id
//   owners:               id, name (Norm, Emily, Homestead, CBT, Pastoral)
//   tags:                 id, name
//   document_types:       id, name
//   users:                id, display_name, google_* columns
//   activity_log:         id (TEXT), user_id, action, detail, document_id, notified, created_at
//   vendor_aliases:       ocr_text, corrected_name

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { processOCR } = require('./ocr');
const { generateThumbnail } = require('./thumbnails');

// ── Config ──────────────────────────────────────────────────────────────

const UPLOAD_PATH = process.env.UPLOAD_PATH || '/app/data/files';
const THUMBNAIL_PATH = process.env.THUMBNAIL_PATH || '/app/data/thumbnails';

// Gmail search query: targeted keywords to find receipts without pulling garbage
const SEARCH_KEYWORDS = [
  'receipt', 'invoice', 'order confirmation', 'order shipped',
  'payment received', 'payment confirmation', 'purchase confirmation',
  'shipping confirmation', 'delivery confirmation', 'warranty',
  'billing statement', 'transaction receipt', 'subscription confirmation',
  'renewal confirmation', 'refund', 'return confirmation'
].map(k => `"${k}"`).join(' OR ');

const DEFAULT_QUERY = `subject:(${SEARCH_KEYWORDS}) -is:spam -is:trash -is:draft`;

// Map subject keywords to Genizah document types
const TYPE_MAP = [
  { pattern: /invoice/i, type: 'Invoice' },
  { pattern: /warranty/i, type: 'Warranty' },
  { pattern: /manual/i, type: 'Manual' },
  { pattern: /subscri/i, type: 'Subscription' },
  { pattern: /ship|deliver/i, type: 'Shipping' },
  { pattern: /refund|return/i, type: 'Refund' },
  // Default fallback is "Receipt"
];

// Attachment types we process
const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff',
]);

// Concurrency guard: prevents overlapping scans per user
const activeScans = new Map();

// ── Database Migrations ─────────────────────────────────────────────────

function initGmailScanTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS gmail_processed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      document_id TEXT,
      subject TEXT,
      sender TEXT,
      email_date TEXT,
      status TEXT DEFAULT 'processed',
      skip_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (document_id) REFERENCES documents(id),
      UNIQUE(user_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS gmail_scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      scan_type TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      messages_found INTEGER DEFAULT 0,
      documents_created INTEGER DEFAULT 0,
      duplicates_skipped INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_message TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS gmail_sender_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_name TEXT,
      action TEXT NOT NULL DEFAULT 'block',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, sender_email)
    );

    CREATE INDEX IF NOT EXISTS idx_gmail_processed_user_msg
      ON gmail_processed(user_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_gmail_scan_runs_user
      ON gmail_scan_runs(user_id, started_at);
  `);

  // Ensure document types exist for auto-classification (TEXT UUIDs)
  const ensureType = getDb().prepare(
    'INSERT OR IGNORE INTO document_types (id, name) VALUES (?, ?)'
  );
  ['Receipt', 'Invoice', 'Warranty', 'Manual', 'Subscription', 'Shipping', 'Refund']
    .forEach(t => ensureType.run(crypto.randomUUID(), t));

  // Ensure "gmail-scan" tag exists
  const existingTag = getDb().prepare('SELECT id FROM tags WHERE name = ?').get('gmail-scan');
  if (!existingTag) {
    getDb().prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(crypto.randomUUID(), 'gmail-scan');
  }

  console.log('[Gmail Scanner] Tables initialized');
}

// ── Gmail API Client ────────────────────────────────────────────────────

function createGmailClient(user) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: user.google_token_expires,
  });

  // Save refreshed tokens back to DB
  oauth2Client.on('tokens', (tokens) => {
    const setClauses = [];
    const values = [];
    if (tokens.access_token) {
      setClauses.push('google_access_token = ?');
      values.push(tokens.access_token);
    }
    if (tokens.refresh_token) {
      setClauses.push('google_refresh_token = ?');
      values.push(tokens.refresh_token);
    }
    if (tokens.expiry_date) {
      setClauses.push('google_token_expires = ?');
      values.push(String(tokens.expiry_date));
    }
    if (setClauses.length > 0) {
      values.push(user.id);
      getDb().prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── Email Parsing Helpers ───────────────────────────────────────────────

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function extractSenderEmail(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : fromHeader.toLowerCase().trim();
}

function extractSenderName(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : '';
}

// Get plain text body from message parts (recursive)
function extractBodyText(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart: look for text/plain first, then strip HTML
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
        return stripHtml(html);
      }
    }
  }

  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return stripHtml(html);
  }

  return '';
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<\/th>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Find attachments in message parts (recursive)
function findAttachments(payload, attachments = []) {
  if (!payload) return attachments;

  if (payload.filename && payload.body && payload.body.attachmentId) {
    const mime = (payload.mimeType || '').toLowerCase();
    if (SUPPORTED_MIME.has(mime)) {
      attachments.push({
        filename: payload.filename,
        mimeType: mime,
        attachmentId: payload.body.attachmentId,
        size: payload.body.size || 0,
      });
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      findAttachments(part, attachments);
    }
  }

  return attachments;
}

// Parse receipt fields from text (reuses OCR-style logic)
function parseReceiptFields(text) {
  const result = { vendor: null, amount: null, date: null };
  if (!text) return result;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Amount: look for labeled totals first, then any dollar amount
  const totalPatterns = [
    /(?:total|amount|charged|paid|payment|subtotal|grand total)[:\s]*\$?\s*([\d,]+\.\d{2})/i,
    /\$\s*([\d,]+\.\d{2})/,
  ];
  for (const pat of totalPatterns) {
    for (const line of lines) {
      const m = line.match(pat);
      if (m) {
        result.amount = parseFloat(m[1].replace(/,/g, ''));
        break;
      }
    }
    if (result.amount) break;
  }

  // Date: look for common date formats
  const datePatterns = [
    /(?:date|purchased|ordered|transaction|payment date)[:\s]*([\w\s,]+\d{4})/i,
    /(?:date|purchased|ordered|transaction|payment date)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(\w+\s+\d{1,2},?\s+\d{4})/,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
  ];
  for (const pat of datePatterns) {
    for (const line of lines) {
      const m = line.match(pat);
      if (m) {
        const parsed = new Date(m[1]);
        if (!isNaN(parsed.getTime())) {
          result.date = parsed.toISOString().split('T')[0];
          break;
        }
      }
    }
    if (result.date) break;
  }

  return result;
}

// Determine document type from subject line
function classifyType(subject) {
  if (!subject) return 'Receipt';
  for (const { pattern, type } of TYPE_MAP) {
    if (pattern.test(subject)) return type;
  }
  return 'Receipt';
}

// ── Sender Rule Checks ──────────────────────────────────────────────────

function isSenderBlocked(userId, senderEmail) {
  const rule = getDb().prepare(
    'SELECT action FROM gmail_sender_rules WHERE user_id = ? AND sender_email = ?'
  ).get(userId, senderEmail.toLowerCase());
  return rule && rule.action === 'block';
}

// ── Owner Resolution ────────────────────────────────────────────────────
// document_owners links to owners table (Norm, Emily, etc.), not users.
// Match user's display_name to owners.name.

function resolveOwnerId(user) {
  const owner = getDb().prepare(
    'SELECT id FROM owners WHERE LOWER(name) = LOWER(?)'
  ).get(user.display_name);
  return owner ? owner.id : null;
}

// ── Core Scan Logic ─────────────────────────────────────────────────────

async function processMessage(gmail, user, messageId) {
  // Check if already processed
  const existing = getDb().prepare(
    'SELECT id FROM gmail_processed WHERE user_id = ? AND message_id = ?'
  ).get(user.id, messageId);
  if (existing) return { status: 'duplicate' };

  // Fetch full message
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = msg.data.payload.headers || [];
  const subject = getHeader(headers, 'Subject') || '(no subject)';
  const from = getHeader(headers, 'From') || '';
  const dateHeader = getHeader(headers, 'Date') || '';
  const senderEmail = extractSenderEmail(from);
  const senderName = extractSenderName(from);
  const emailDate = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  // Check sender blacklist
  if (isSenderBlocked(user.id, senderEmail)) {
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'blocked sender')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'blocked' };
  }

  // Find attachments and body text
  const attachments = findAttachments(msg.data.payload);
  const bodyText = extractBodyText(msg.data.payload);

  // Determine document type from subject
  const typeName = classifyType(subject);
  const typeRow = getDb().prepare('SELECT id FROM document_types WHERE name = ?').get(typeName);
  const typeId = typeRow ? typeRow.id : null;

  if (!typeId) {
    console.warn(`[Gmail Scanner] No type_id found for "${typeName}", skipping`);
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'no document type')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'skipped', reason: 'no document type' };
  }

  // Get the gmail-scan tag
  const tagRow = getDb().prepare('SELECT id FROM tags WHERE name = ?').get('gmail-scan');

  // Resolve vendor via alias learning
  let vendorName = senderName || senderEmail.split('@')[0];
  const alias = getDb().prepare(
    'SELECT corrected_name FROM vendor_aliases WHERE LOWER(ocr_text) = LOWER(?)'
  ).get(vendorName);
  if (alias) vendorName = alias.corrected_name;

  // Parse fields from body text
  const parsed = parseReceiptFields(bodyText);

  // Build notes block
  const notesHeader = [
    `📧 Gmail ${typeName}`,
    `From: ${from}`,
    `Date: ${new Date(emailDate).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}`,
    `Subject: ${subject}`,
    '---',
  ].join('\n');

  const trimmedBody = bodyText.length > 3000
    ? bodyText.substring(0, 3000) + '\n... (truncated)'
    : bodyText;

  const fullNotes = notesHeader + '\n' + trimmedBody;

  // Resolve owner for document_owners
  const ownerId = resolveOwnerId(user);

  let documentId = null;

  if (attachments.length > 0) {
    // ── Path A: Has attachments (PDF/images) ──
    // Download first attachment to use as the document's file_path

    const firstAtt = attachments[0];
    let primaryFilePath = null;
    let primaryOriginalName = null;
    let primaryMime = null;
    let primarySize = 0;

    try {
      const attData = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: messageId,
        id: firstAtt.attachmentId,
      });

      const fileBuffer = Buffer.from(attData.data.data, 'base64url');
      const ext = firstAtt.mimeType.includes('pdf') ? '.pdf'
        : firstAtt.mimeType.includes('png') ? '.png'
        : firstAtt.mimeType.includes('webp') ? '.webp'
        : '.jpg';
      const storedName = `${crypto.randomUUID()}${ext}`;
      primaryFilePath = storedName;
      primaryOriginalName = firstAtt.filename;
      primaryMime = firstAtt.mimeType;
      primarySize = fileBuffer.length;

      fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fileBuffer);

      // Generate thumbnail for images
      if (!firstAtt.mimeType.includes('pdf')) {
        try {
          await generateThumbnail(
            path.join(UPLOAD_PATH, storedName),
            path.join(THUMBNAIL_PATH, `${storedName}.webp`)
          );
        } catch (e) {
          console.warn(`[Gmail Scanner] Thumbnail failed for ${storedName}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[Gmail Scanner] First attachment download failed:`, e.message);
      // Can't create document without file_path, skip
      getDb().prepare(`
        INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'attachment download failed')
      `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
      return { status: 'skipped', reason: 'attachment download failed' };
    }

    // Create document
    documentId = crypto.randomUUID();
    const thumbnailRel = primaryMime && !primaryMime.includes('pdf')
      ? `${primaryFilePath}.webp` : null;

    getDb().prepare(`
      INSERT INTO documents (id, title, type_id, uploaded_by, file_path, thumbnail_path,
        original_filename, mime_type, file_size, vendor, amount, document_date, notes, ocr_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `).run(
      documentId, subject, typeId, user.id,
      primaryFilePath, thumbnailRel,
      primaryOriginalName, primaryMime, primarySize,
      vendorName, parsed.amount || null,
      parsed.date || emailDate.split('T')[0],
      fullNotes
    );

    // Create attachment record for primary file
    getDb().prepare(`
      INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      crypto.randomUUID(), documentId,
      primaryFilePath, thumbnailRel,
      primaryOriginalName, primaryMime, primarySize
    );

    // Download additional attachments (2nd, 3rd, etc.)
    for (let i = 1; i < attachments.length; i++) {
      const att = attachments[i];
      try {
        const attData = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: messageId,
          id: att.attachmentId,
        });

        const fileBuffer = Buffer.from(attData.data.data, 'base64url');
        const ext = att.mimeType.includes('pdf') ? '.pdf'
          : att.mimeType.includes('png') ? '.png'
          : att.mimeType.includes('webp') ? '.webp'
          : '.jpg';
        const storedName = `${crypto.randomUUID()}${ext}`;

        fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fileBuffer);

        let thumbPath = null;
        if (!att.mimeType.includes('pdf')) {
          try {
            thumbPath = `${storedName}.webp`;
            await generateThumbnail(
              path.join(UPLOAD_PATH, storedName),
              path.join(THUMBNAIL_PATH, thumbPath)
            );
          } catch (e) {
            thumbPath = null;
            console.warn(`[Gmail Scanner] Thumbnail failed for ${storedName}:`, e.message);
          }
        }

        getDb().prepare(`
          INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), documentId,
          storedName, thumbPath,
          att.filename, att.mimeType, fileBuffer.length, i
        );
      } catch (e) {
        console.error(`[Gmail Scanner] Attachment ${i} download failed:`, e.message);
      }
    }

    // Run OCR on primary image (not PDFs) to refine parsed fields
    if (primaryMime && !primaryMime.includes('pdf')) {
      try {
        const ocrResult = await processOCR(path.join(UPLOAD_PATH, primaryFilePath));
        if (ocrResult) {
          const ocrText = ocrResult.text || '';
          const ocrParsed = parseReceiptFields(ocrText);

          const updates = [];
          const vals = [];

          updates.push('ocr_text = ?', "ocr_status = 'complete'");
          vals.push(ocrText);

          if (ocrParsed.amount && !parsed.amount) {
            updates.push('amount = ?');
            vals.push(ocrParsed.amount);
          }
          if (ocrParsed.vendor) {
            const ocrAlias = getDb().prepare(
              'SELECT corrected_name FROM vendor_aliases WHERE LOWER(ocr_text) = LOWER(?)'
            ).get(ocrParsed.vendor);
            if (ocrAlias) {
              updates.push('vendor = ?');
              vals.push(ocrAlias.corrected_name);
            }
          }

          vals.push(documentId);
          getDb().prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
        }
      } catch (e) {
        console.warn(`[Gmail Scanner] OCR failed:`, e.message);
      }
    }

  } else if (bodyText.trim()) {
    // ── Path B: Body-only receipt (no attachment) ──
    // documents.file_path is NOT NULL, so save the email body as a .txt file

    const storedName = `${crypto.randomUUID()}.txt`;
    fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fullNotes, 'utf-8');

    documentId = crypto.randomUUID();
    getDb().prepare(`
      INSERT INTO documents (id, title, type_id, uploaded_by, file_path,
        original_filename, mime_type, file_size, vendor, amount, document_date, notes,
        ocr_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, 'complete', datetime('now'), datetime('now'))
    `).run(
      documentId, subject, typeId, user.id,
      storedName,
      `${subject.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50)}.txt`,
      Buffer.byteLength(fullNotes, 'utf-8'),
      vendorName, parsed.amount || null,
      parsed.date || emailDate.split('T')[0],
      fullNotes
    );

  } else {
    // No attachment AND no body text: skip
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'no content')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'skipped', reason: 'no content' };
  }

  // Assign owner (match user's display_name to owners table)
  if (ownerId) {
    getDb().prepare('INSERT OR IGNORE INTO document_owners (document_id, owner_id) VALUES (?, ?)')
      .run(documentId, ownerId);
  }

  // Tag with gmail-scan
  if (tagRow) {
    getDb().prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)')
      .run(documentId, tagRow.id);
  }

  // Record as processed
  getDb().prepare(`
    INSERT INTO gmail_processed (user_id, message_id, thread_id, document_id, subject, sender, email_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processed')
  `).run(user.id, messageId, msg.data.threadId, documentId, subject, senderEmail, emailDate);

  // Activity log entry
  getDb().prepare(`
    INSERT INTO activity_log (id, user_id, action, detail, document_id, created_at)
    VALUES (?, ?, 'gmail_receipt', ?, ?, datetime('now'))
  `).run(
    crypto.randomUUID(),
    user.id,
    JSON.stringify({
      subject,
      vendor: vendorName,
      amount: parsed.amount,
      type: typeName,
      has_attachment: attachments.length > 0,
    }),
    documentId
  );

  return { status: 'created', documentId, subject, vendor: vendorName };
}

// ── Main Scan Function ──────────────────────────────────────────────────

async function scanUserGmail(user, scanType = 'scheduled') {
  // Concurrency guard
  if (activeScans.get(user.id)) {
    console.log(`[Gmail Scanner] Scan already running for user ${user.id}, skipping`);
    return null;
  }
  activeScans.set(user.id, true);

  // Create scan run record
  const run = getDb().prepare(`
    INSERT INTO gmail_scan_runs (user_id, scan_type, started_at, status)
    VALUES (?, ?, datetime('now'), 'running')
  `).run(user.id, scanType);
  const runId = run.lastInsertRowid;

  const stats = { found: 0, created: 0, duplicates: 0, errors: 0 };

  try {
    const gmail = createGmailClient(user);

    // Build time-scoped query
    let query = DEFAULT_QUERY;

    if (scanType === 'manual') {
      query += ' newer_than:7d';
    } else {
      // Scheduled: pick up from last completed scan
      const lastRun = getDb().prepare(`
        SELECT completed_at FROM gmail_scan_runs
        WHERE user_id = ? AND status = 'completed' AND scan_type IN ('scheduled', 'manual')
        ORDER BY completed_at DESC LIMIT 1
      `).get(user.id);

      if (lastRun && lastRun.completed_at) {
        const epoch = Math.floor(new Date(lastRun.completed_at).getTime() / 1000);
        query += ` after:${epoch}`;
      } else {
        query += ' newer_than:7d';
      }
    }

    // Search Gmail (paginated, capped at 200)
    let allMessageIds = [];
    let pageToken = null;

    do {
      const listParams = { userId: 'me', q: query, maxResults: 50 };
      if (pageToken) listParams.pageToken = pageToken;

      const res = await gmail.users.messages.list(listParams);
      if (res.data.messages) {
        allMessageIds.push(...res.data.messages.map(m => m.id));
      }
      pageToken = res.data.nextPageToken;

      if (allMessageIds.length >= 200) break;
    } while (pageToken);

    stats.found = allMessageIds.length;
    console.log(`[Gmail Scanner] Found ${stats.found} messages for user ${user.id} (${scanType})`);

    // Process each message
    for (const msgId of allMessageIds) {
      try {
        const result = await processMessage(gmail, user, msgId);
        if (result.status === 'created') stats.created++;
        else if (result.status === 'duplicate') stats.duplicates++;
      } catch (e) {
        stats.errors++;
        console.error(`[Gmail Scanner] Error processing message ${msgId}:`, e.message);
      }
    }

    // Update run record
    getDb().prepare(`
      UPDATE gmail_scan_runs
      SET completed_at = datetime('now'),
          messages_found = ?, documents_created = ?,
          duplicates_skipped = ?, errors = ?,
          status = 'completed'
      WHERE id = ?
    `).run(stats.found, stats.created, stats.duplicates, stats.errors, runId);

    // Activity log summary (only if documents were created)
    if (stats.created > 0) {
      getDb().prepare(`
        INSERT INTO activity_log (id, user_id, action, detail, created_at)
        VALUES (?, ?, 'gmail_scan_complete', ?, datetime('now'))
      `).run(
        crypto.randomUUID(),
        user.id,
        JSON.stringify({
          scan_type: scanType,
          found: stats.found,
          created: stats.created,
          duplicates: stats.duplicates,
          errors: stats.errors,
        })
      );
    }

    console.log(`[Gmail Scanner] Scan complete for user ${user.id}: ${stats.created} created, ${stats.duplicates} dupes, ${stats.errors} errors`);

  } catch (e) {
    console.error(`[Gmail Scanner] Scan failed for user ${user.id}:`, e.message);
    getDb().prepare(`
      UPDATE gmail_scan_runs
      SET completed_at = datetime('now'), status = 'failed', error_message = ?
      WHERE id = ?
    `).run(e.message, runId);
  } finally {
    activeScans.delete(user.id);
  }

  return stats;
}

// ── Scheduled Scan Runner ───────────────────────────────────────────────
// Called by cron every 15 minutes; gates to 7 AM - 10 PM Central

async function runScheduledScan() {
  const now = new Date();

  // Convert to Central time (America/Chicago)
  const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = centralTime.getHours();
  const minute = centralTime.getMinutes();

  // Only run between 7:00 AM and 10:00 PM Central
  if (hour < 7 || hour > 22) return;
  if (hour === 22 && minute > 0) return;

  console.log(`[Gmail Scanner] Scheduled scan starting (${centralTime.toLocaleTimeString()})`);

  // Find all users with linked Gmail
  const users = getDb().prepare(`
    SELECT * FROM users
    WHERE google_refresh_token IS NOT NULL
      AND google_scopes LIKE '%gmail.readonly%'
  `).all();

  for (const user of users) {
    try {
      await scanUserGmail(user, 'scheduled');
    } catch (e) {
      console.error(`[Gmail Scanner] Scheduled scan error for user ${user.id}:`, e.message);
    }
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  initGmailScanTables,
  scanUserGmail,
  runScheduledScan,
};
