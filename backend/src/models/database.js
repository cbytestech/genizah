const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/db/genizah.sqlite');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT,
      auth_method TEXT DEFAULT 'local',
      authentik_sub TEXT UNIQUE,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_types (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT REFERENCES owners(id),
      type_id TEXT NOT NULL REFERENCES document_types(id),
      status TEXT DEFAULT 'active',
      submitted_at TEXT DEFAULT (datetime('now')),
      document_date TEXT,
      expiration_date TEXT,
      amount REAL,
      vendor TEXT,
      notes TEXT,
      ocr_text TEXT,
      ocr_status TEXT DEFAULT 'pending',
      original_filename TEXT,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      mime_type TEXT,
      file_size INTEGER,
      page_count INTEGER DEFAULT 1,
      magen_shared BOOLEAN DEFAULT 0,
      magen_ref TEXT,
      uploaded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_owners (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, owner_id)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_owners_doc ON document_owners(document_id);
    CREATE INDEX IF NOT EXISTS idx_doc_owners_owner ON document_owners(owner_id);

    CREATE TABLE IF NOT EXISTS document_attachments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      thumbnail_path TEXT,
      original_filename TEXT,
      mime_type TEXT,
      file_size INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Multi-owner junction (a document can belong to multiple owners)
    CREATE TABLE IF NOT EXISTS document_owners (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, owner_id)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_owners_doc ON document_owners(document_id);
    CREATE INDEX IF NOT EXISTS idx_doc_owners_owner ON document_owners(owner_id);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS document_tags (
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail TEXT,
      notified BOOLEAN DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL,
      file_count INTEGER,
      total_size_bytes INTEGER,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
    CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type_id);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_documents_submitted ON documents(submitted_at);
    CREATE INDEX IF NOT EXISTS idx_documents_expiration ON documents(expiration_date);
    CREATE INDEX IF NOT EXISTS idx_documents_uploaded_by ON documents(uploaded_by);
    CREATE INDEX IF NOT EXISTS idx_attachments_doc ON document_attachments(document_id);
    CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_document ON activity_log(document_id);
    CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_documents_fts ON documents(ocr_text);

    CREATE TABLE IF NOT EXISTS vendor_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ocr_text TEXT NOT NULL,
      corrected_name TEXT NOT NULL,
      match_count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(ocr_text)
    );

    CREATE INDEX IF NOT EXISTS idx_vendor_aliases_ocr ON vendor_aliases(ocr_text);
  `);

  const insertOwner = db.prepare('INSERT OR IGNORE INTO owners (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)');
  insertOwner.run('owner-homestead', 'Homestead', '#3ad98e', '🏠', 1);
  insertOwner.run('owner-cbt', 'CBT', '#4a9eff', '🍪', 2);
  insertOwner.run('owner-emily', 'Emily', '#e88aed', '👩', 3);
  insertOwner.run('owner-norm', 'Norm', '#f77f3a', '👨', 4);
  insertOwner.run('owner-pastoral', 'Pastoral', '#c9a227', '⛪', 5);

  const insertType = db.prepare('INSERT OR IGNORE INTO document_types (id, name, icon, sort_order) VALUES (?, ?, ?, ?)');
  insertType.run('type-receipt', 'Receipt', '🧾', 1);
  insertType.run('type-letter', 'Letter', '✉️', 2);
  insertType.run('type-manual', 'Manual', '📖', 3);
  insertType.run('type-invoice', 'Invoice', '📄', 4);
  insertType.run('type-certificate', 'Certificate', '📜', 5);
  insertType.run('type-policy', 'Policy', '🛡️', 6);
  insertType.run('type-title', 'Title', '📋', 7);
  insertType.run('type-license', 'License', '🪪', 8);
  insertType.run('type-statement', 'Statement', '🏦', 9);
  insertType.run('type-contract', 'Contract', '📝', 10);
  insertType.run('type-warranty', 'Warranty', '🔧', 11);
  insertType.run('type-tax-form', 'Tax Form', '🏛️', 12);
  insertType.run('type-medical', 'Medical Record', '🏥', 13);
  insertType.run('type-id-document', 'ID Document', '🆔', 14);
  insertType.run('type-photo', 'Photo/Image', '📸', 15);
  insertType.run('type-w2', 'W-2', '🏛️', 16);
  insertType.run('type-1099', '1099', '🏛️', 17);
  insertType.run('type-donation', 'Donation Receipt', '🎁', 18);
  insertType.run('type-expense', 'Business Expense', '💼', 19);
  insertType.run('type-other', 'Other', '📁', 99);

  // Auto-migrate: copy existing owner_id into document_owners junction table
  const unmigrated = db.prepare(`
    SELECT d.id, d.owner_id FROM documents d
    WHERE d.owner_id IS NOT NULL
    AND d.id NOT IN (SELECT document_id FROM document_owners)
  `).all();
  if (unmigrated.length > 0) {
    const insertDocOwner = db.prepare('INSERT OR IGNORE INTO document_owners (document_id, owner_id) VALUES (?, ?)');
    for (const row of unmigrated) {
      insertDocOwner.run(row.id, row.owner_id);
    }
    console.log(`[Genizah] Migrated ${unmigrated.length} documents to multi-owner table`);
  }
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { getDb, closeDb };
