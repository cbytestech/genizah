const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const { authenticate } = require('../middleware/auth');
const { generateThumbnail } = require('../services/thumbnails');
const { logActivity, notifyUsers } = require('../services/notifications');
const { processDocument } = require('../services/ocr');

const router = express.Router();
router.use(authenticate);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
    const yearMonth = new Date().toISOString().slice(0, 7);
    const dest = path.join(uploadPath, yearMonth);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 25) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// Helper: apply owners to a document (multi-owner)
function applyOwners(db, documentId, ownerIds) {
  db.prepare('DELETE FROM document_owners WHERE document_id = ?').run(documentId);
  const insert = db.prepare('INSERT OR IGNORE INTO document_owners (document_id, owner_id) VALUES (?, ?)');
  for (const oid of ownerIds) {
    if (oid) insert.run(documentId, oid);
  }
}

// Helper: apply tags
function applyTags(db, documentId, tagNames) {
  const findTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const insertTag = db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)');
  const linkTag = db.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)');
  for (const name of tagNames) {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    let tag = findTag.get(trimmed);
    if (!tag) { const id = uuidv4(); insertTag.run(id, trimmed); tag = { id }; }
    linkTag.run(documentId, tag.id);
  }
}

// Helper: get owners for a document
function getDocOwners(db, documentId) {
  return db.prepare(`
    SELECT o.id, o.name, o.color, o.icon FROM owners o
    JOIN document_owners do2 ON o.id = do2.owner_id
    WHERE do2.document_id = ?
    ORDER BY o.sort_order
  `).all(documentId);
}

// Upload document
router.post('/', upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

    const { title, owner_ids, owner_id, type_id, document_date, expiration_date, amount, vendor, notes, tags } = req.body;
    if (!title || !type_id) return res.status(400).json({ error: 'title and type_id are required' });

    // Support both single owner_id and multi owner_ids
    let ownerList = [];
    if (owner_ids) {
      ownerList = typeof owner_ids === 'string' ? JSON.parse(owner_ids) : owner_ids;
    } else if (owner_id) {
      ownerList = [owner_id];
    }
    if (ownerList.length === 0) return res.status(400).json({ error: 'At least one owner required' });

    const db = getDb();
    const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
    const primaryFile = req.files[0];
    const primaryRelPath = path.relative(uploadBase, primaryFile.path);
    const primaryThumb = await generateThumbnail(primaryFile.path, uuidv4(), primaryFile.mimetype);

    const docId = uuidv4();
    db.prepare(`
      INSERT INTO documents (id, title, owner_id, type_id, status, document_date, expiration_date,
        amount, vendor, notes, original_filename, file_path, thumbnail_path, mime_type, file_size,
        page_count, uploaded_by)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, title, ownerList[0], type_id,
      document_date || null, expiration_date || null,
      amount ? parseFloat(amount) : null, vendor || null, notes || null,
      primaryFile.originalname, primaryRelPath, primaryThumb, primaryFile.mimetype, primaryFile.size,
      req.files.length, req.user.id);

    // Multi-owner junction
    applyOwners(db, docId, ownerList);

    // Additional files become attachments
    if (req.files.length > 1) {
      const insertAttach = db.prepare(`
        INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 1; i < req.files.length; i++) {
        const f = req.files[i];
        const relPath = path.relative(uploadBase, f.path);
        const thumb = await generateThumbnail(f.path, uuidv4(), f.mimetype);
        insertAttach.run(uuidv4(), docId, relPath, thumb, f.originalname, f.mimetype, f.size, i);
      }
    }

    if (tags) {
      const tagList = typeof tags === 'string' ? JSON.parse(tags) : tags;
      applyTags(db, docId, tagList);
    }

    logActivity(req.user.id, docId, 'uploaded', req.user.displayName + ' uploaded "' + title + '"');
    notifyUsers(req.user, 'uploaded', '📄 ' + req.user.displayName + ' uploaded "' + title + '"');

    // Trigger OCR in background (don't block the response)
    processDocument(docId, req.files[0].path, req.files[0].mimetype).catch(err => {
      console.error('[Genizah] Background OCR failed:', err.message);
    });

    res.status(201).json({ document: { id: docId, title, pages: req.files.length } });
  } catch (err) {
    console.error('[Genizah] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add attachments to existing document
router.post('/:id/attachments', upload.array('files', 20), async (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });

    const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM document_attachments WHERE document_id = ?').get(req.params.id).m || 0;
    const insertAttach = db.prepare(`
      INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < req.files.length; i++) {
      const f = req.files[i];
      const relPath = path.relative(uploadBase, f.path);
      const thumb = await generateThumbnail(f.path, uuidv4(), f.mimetype);
      insertAttach.run(uuidv4(), req.params.id, relPath, thumb, f.originalname, f.mimetype, f.size, maxOrder + i + 1);
    }

    const totalAttachments = db.prepare('SELECT COUNT(*) as c FROM document_attachments WHERE document_id = ?').get(req.params.id).c;
    db.prepare("UPDATE documents SET page_count = ?, updated_at = datetime('now') WHERE id = ?").run(totalAttachments + 1, req.params.id);

    logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' added ' + req.files.length + ' page(s) to "' + doc.title + '"');
    res.status(201).json({ totalPages: totalAttachments + 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete attachment
router.delete('/:id/attachments/:attachId', (req, res) => {
  const db = getDb();
  const attach = db.prepare('SELECT * FROM document_attachments WHERE id = ? AND document_id = ?').get(req.params.attachId, req.params.id);
  if (!attach) return res.status(404).json({ error: 'Attachment not found' });
  const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
  const thumbBase = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');
  try { fs.unlinkSync(path.join(uploadBase, attach.file_path)); } catch (e) {}
  try { if (attach.thumbnail_path) fs.unlinkSync(path.join(thumbBase, attach.thumbnail_path)); } catch (e) {}
  db.prepare('DELETE FROM document_attachments WHERE id = ?').run(req.params.attachId);

  // Update page count
  const remaining = db.prepare('SELECT COUNT(*) as c FROM document_attachments WHERE document_id = ?').get(req.params.id).c;
  db.prepare("UPDATE documents SET page_count = ?, updated_at = datetime('now') WHERE id = ?").run(remaining + 1, req.params.id);

  const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(req.params.id);
  logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' removed a page from "' + doc.title + '"');
  res.json({ deleted: true, remainingPages: remaining + 1 });
});

// Delete primary image (promotes first attachment if available)
router.delete('/:id/primary-image', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const attachments = db.prepare('SELECT * FROM document_attachments WHERE document_id = ? ORDER BY sort_order ASC').all(req.params.id);
  if (attachments.length === 0) return res.status(400).json({ error: 'Cannot delete the only page' });

  const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
  const thumbBase = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');

  // Delete old primary files from disk
  try { fs.unlinkSync(path.join(uploadBase, doc.file_path)); } catch (e) {}
  try { if (doc.thumbnail_path) fs.unlinkSync(path.join(thumbBase, doc.thumbnail_path)); } catch (e) {}

  // Promote first attachment to primary
  const promoted = attachments[0];
  db.prepare(`UPDATE documents SET file_path = ?, thumbnail_path = ?, mime_type = ?, file_size = ?,
    original_filename = ?, page_count = ?, updated_at = datetime('now') WHERE id = ?`).run(
    promoted.file_path, promoted.thumbnail_path, promoted.mime_type, promoted.file_size,
    promoted.original_filename, attachments.length, req.params.id
  );
  db.prepare('DELETE FROM document_attachments WHERE id = ?').run(promoted.id);

  logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' removed primary image from "' + doc.title + '"');
  res.json({ deleted: true, promoted: promoted.id, remainingPages: attachments.length });
});

// Replace primary image (from crop/rotate)
router.put('/:id/primary-image', upload.single('file'), async (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
    const thumbBase = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');

    // Delete old files
    try { fs.unlinkSync(path.join(uploadBase, doc.file_path)); } catch (e) {}
    try { if (doc.thumbnail_path) fs.unlinkSync(path.join(thumbBase, doc.thumbnail_path)); } catch (e) {}

    const relPath = path.relative(uploadBase, req.file.path);
    const thumb = await generateThumbnail(req.file.path, uuidv4(), req.file.mimetype);

    db.prepare(`UPDATE documents SET file_path = ?, thumbnail_path = ?, mime_type = ?, file_size = ?,
      updated_at = datetime('now') WHERE id = ?`).run(relPath, thumb, req.file.mimetype, req.file.size, req.params.id);

    logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' edited image on "' + doc.title + '"');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Replace attachment image (from crop/rotate)
router.put('/:id/attachments/:attachId', upload.single('file'), async (req, res) => {
  try {
    const db = getDb();
    const attach = db.prepare('SELECT * FROM document_attachments WHERE id = ? AND document_id = ?').get(req.params.attachId, req.params.id);
    if (!attach) return res.status(404).json({ error: 'Attachment not found' });
    if (!req.file) return res.status(400).json({ error: 'No file' });

    const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
    const thumbBase = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');

    // Delete old files
    try { fs.unlinkSync(path.join(uploadBase, attach.file_path)); } catch (e) {}
    try { if (attach.thumbnail_path) fs.unlinkSync(path.join(thumbBase, attach.thumbnail_path)); } catch (e) {}

    const relPath = path.relative(uploadBase, req.file.path);
    const thumb = await generateThumbnail(req.file.path, uuidv4(), req.file.mimetype);

    db.prepare(`UPDATE document_attachments SET file_path = ?, thumbnail_path = ?, mime_type = ?, file_size = ?
      WHERE id = ?`).run(relPath, thumb, req.file.mimetype, req.file.size, req.params.attachId);

    const doc = db.prepare('SELECT title FROM documents WHERE id = ?').get(req.params.id);
    logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' edited a page on "' + doc.title + '"');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// OCR: scan an uploaded file and return parsed fields (used by ScanPage pre-fill)
router.post('/ocr-scan', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  try {
    const { extractText, parseOcrText } = require('../services/ocr');
    const rawText = extractText(req.file.path);
    const parsed = parseOcrText(rawText);

    // Clean up the temp file
    try { fs.unlinkSync(req.file.path); } catch (e) {}

    res.json(parsed);
  } catch (err) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// Re-run OCR on an existing document
router.post('/:id/ocr', async (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  const uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
  const filePath = path.join(uploadBase, doc.file_path);

  const result = await processDocument(doc.id, filePath, doc.mime_type);
  res.json(result || { rawText: '', vendor: null, amount: null, date: null });
});

// Dashboard stats
router.get('/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as c FROM documents WHERE status != 'archived'").get().c;
  const byOwner = db.prepare(`
    SELECT o.name, o.color, o.icon, COUNT(DISTINCT do2.document_id) as count
    FROM owners o LEFT JOIN document_owners do2 ON o.id = do2.owner_id
    LEFT JOIN documents d ON do2.document_id = d.id AND d.status != 'archived'
    GROUP BY o.id ORDER BY o.sort_order
  `).all();
  const byType = db.prepare(`
    SELECT t.name, t.icon, COUNT(d.id) as count
    FROM document_types t LEFT JOIN documents d ON d.type_id = t.id AND d.status != 'archived'
    GROUP BY t.id HAVING count > 0 ORDER BY count DESC LIMIT 8
  `).all();
  const recentActivity = db.prepare(`
    SELECT a.*, u.display_name as user_name, d.title as document_title
    FROM activity_log a LEFT JOIN users u ON a.user_id = u.id LEFT JOIN documents d ON a.document_id = d.id
    WHERE a.action != 'viewed' ORDER BY a.created_at DESC LIMIT 5
  `).all();
  const expiringSoon = db.prepare(`
    SELECT d.title, d.expiration_date
    FROM documents d
    WHERE d.status = 'active' AND d.expiration_date IS NOT NULL AND d.expiration_date <= date('now', '+30 days') AND d.expiration_date >= date('now')
    ORDER BY d.expiration_date ASC LIMIT 5
  `).all();
  const totalSize = db.prepare('SELECT SUM(file_size) as s FROM documents').get().s || 0;
  res.json({ total, byOwner, byType, recentActivity, expiringSoon, totalSize });
});

// List documents
router.get('/', (req, res) => {
  const { owner_id, type_id, status, search, date_from, date_to, sort, order, page, limit } = req.query;
  const db = getDb();
  const conditions = [];
  const params = [];

  // Multi-owner filter: find docs that have this owner in the junction table
  if (owner_id) {
    conditions.push('d.id IN (SELECT document_id FROM document_owners WHERE owner_id = ?)');
    params.push(owner_id);
  }
  if (type_id) { conditions.push('d.type_id = ?'); params.push(type_id); }
  if (status) { conditions.push('d.status = ?'); params.push(status); }
  else { conditions.push("d.status != 'archived'"); }
  if (date_from) { conditions.push('d.submitted_at >= ?'); params.push(date_from); }
  if (date_to) { conditions.push('d.submitted_at <= ?'); params.push(date_to); }
  if (search) {
    conditions.push('(d.title LIKE ? OR d.ocr_text LIKE ? OR d.vendor LIKE ? OR d.notes LIKE ?)');
    const term = '%' + search + '%';
    params.push(term, term, term, term);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const sortCol = ['submitted_at', 'document_date', 'title', 'amount', 'expiration_date'].includes(sort) ? sort : 'submitted_at';
  const sortDir = order === 'asc' ? 'ASC' : 'DESC';
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 20));
  const offset = (pageNum - 1) * pageSize;

  const countRow = db.prepare('SELECT COUNT(*) as total FROM documents d ' + where).get(...params);
  const docs = db.prepare(
    'SELECT d.*, t.name as type_name, t.icon as type_icon, u.display_name as uploaded_by_name ' +
    'FROM documents d LEFT JOIN document_types t ON d.type_id = t.id LEFT JOIN users u ON d.uploaded_by = u.id ' +
    where + ' ORDER BY d.' + sortCol + ' ' + sortDir + ' LIMIT ? OFFSET ?'
  ).all(...params, pageSize, offset);

  const tagStmt = db.prepare('SELECT t.name FROM tags t JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.document_id = ?');
  const attachCountStmt = db.prepare('SELECT COUNT(*) as c FROM document_attachments WHERE document_id = ?');

  const results = docs.map(function(doc) {
    var owners = getDocOwners(db, doc.id);
    return Object.assign({}, doc, {
      owners: owners,
      owner_name: owners.map(function(o) { return o.name; }).join(', '),
      owner_color: owners.length > 0 ? owners[0].color : '#888',
      owner_icon: owners.length > 0 ? owners[0].icon : '📁',
      tags: tagStmt.all(doc.id).map(function(t) { return t.name; }),
      attachment_count: attachCountStmt.get(doc.id).c
    });
  });

  res.json({ documents: results, pagination: { page: pageNum, limit: pageSize, total: countRow.total, totalPages: Math.ceil(countRow.total / pageSize) } });
});

// Get single document
router.get('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare(
    'SELECT d.*, t.name as type_name, t.icon as type_icon, u.display_name as uploaded_by_name ' +
    'FROM documents d LEFT JOIN document_types t ON d.type_id = t.id LEFT JOIN users u ON d.uploaded_by = u.id WHERE d.id = ?'
  ).get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  var owners = getDocOwners(db, doc.id);
  var tags = db.prepare('SELECT t.name FROM tags t JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.document_id = ?').all(doc.id).map(function(t) { return t.name; });
  var attachments = db.prepare('SELECT * FROM document_attachments WHERE document_id = ? ORDER BY sort_order ASC').all(doc.id);

  logActivity(req.user.id, doc.id, 'viewed', req.user.displayName + ' viewed "' + doc.title + '"');

  res.json(Object.assign({}, doc, {
    owners: owners,
    owner_name: owners.map(function(o) { return o.name; }).join(', '),
    owner_color: owners.length > 0 ? owners[0].color : '#888',
    owner_icon: owners.length > 0 ? owners[0].icon : '📁',
    tags: tags,
    attachments: attachments
  }));
});

// Update document
router.patch('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  var fields = ['title', 'type_id', 'status', 'document_date', 'expiration_date', 'amount', 'vendor', 'notes'];
  var updates = [];
  var params = [];

  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (req.body[field] !== undefined) {
      updates.push(field + ' = ?');
      params.push(req.body[field] === '' ? null : req.body[field]);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare('UPDATE documents SET ' + updates.join(', ') + ' WHERE id = ?').run.apply(db.prepare('UPDATE documents SET ' + updates.join(', ') + ' WHERE id = ?'), params);
  }

  // Multi-owner update
  if (req.body.owner_ids) {
    var ownerIds = typeof req.body.owner_ids === 'string' ? JSON.parse(req.body.owner_ids) : req.body.owner_ids;
    applyOwners(db, req.params.id, ownerIds);
    // Also update legacy owner_id to first
    if (ownerIds.length > 0) {
      db.prepare('UPDATE documents SET owner_id = ? WHERE id = ?').run(ownerIds[0], req.params.id);
    }
  }

  if (req.body.tags) {
    var tagList = typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags;
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(req.params.id);
    applyTags(db, req.params.id, tagList);
  }

  logActivity(req.user.id, req.params.id, 'edited', req.user.displayName + ' edited "' + doc.title + '"');
  notifyUsers(req.user, 'edited', '✏️ ' + req.user.displayName + ' edited "' + doc.title + '"');

  // Vendor learning: if vendor was changed and doc has OCR text, learn the mapping
  if (req.body.vendor && doc.ocr_text && req.body.vendor !== doc.vendor) {
    try {
      const { parseOcrText, learnVendor } = require('../services/ocr');
      const ocrParsed = parseOcrText(doc.ocr_text);
      if (ocrParsed.ocrVendor || ocrParsed.vendor) {
        learnVendor(ocrParsed.ocrVendor || ocrParsed.vendor, req.body.vendor);
      }
    } catch (e) { /* learning is best-effort */ }
  }

  var updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Delete document
router.delete('/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  var uploadBase = process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files');
  var thumbBase = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');

  var attachments = db.prepare('SELECT * FROM document_attachments WHERE document_id = ?').all(req.params.id);
  for (var a of attachments) {
    try { fs.unlinkSync(path.join(uploadBase, a.file_path)); } catch (e) {}
    try { if (a.thumbnail_path) fs.unlinkSync(path.join(thumbBase, a.thumbnail_path)); } catch (e) {}
  }
  try { fs.unlinkSync(path.join(uploadBase, doc.file_path)); } catch (e) {}
  try { if (doc.thumbnail_path) fs.unlinkSync(path.join(thumbBase, doc.thumbnail_path)); } catch (e) {}

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  logActivity(req.user.id, null, 'deleted', req.user.displayName + ' deleted "' + doc.title + '"');
  notifyUsers(req.user, 'deleted', '🗑️ ' + req.user.displayName + ' deleted "' + doc.title + '"');
  res.json({ deleted: true });
});

module.exports = router;
