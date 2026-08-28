// Genizah — Sync status routes
// Reports Google Drive backup health to the dashboard

const express = require('express');
const { getDb } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Get latest sync status
router.get('/status', (req, res) => {
  const db = getDb();

  const latest = db.prepare(`
    SELECT * FROM sync_status
    WHERE sync_type = 'gdrive'
    ORDER BY completed_at DESC
    LIMIT 1
  `).get();

  // Calculate health: green if synced within 12h, yellow within 24h, red otherwise
  let health = 'unknown';
  if (latest) {
    const hoursSince = (Date.now() - new Date(latest.completed_at).getTime()) / (1000 * 60 * 60);
    if (latest.status === 'success' && hoursSince < 12) health = 'green';
    else if (latest.status === 'success' && hoursSince < 24) health = 'yellow';
    else health = 'red';
  }

  // Document stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_documents,
      SUM(file_size) as total_bytes,
      MIN(submitted_at) as oldest_document,
      MAX(submitted_at) as newest_document
    FROM documents
  `).get();

  res.json({
    health,
    lastSync: latest || null,
    stats
  });
});

// Record sync result (called by rclone-sync.sh via curl)
router.post('/report', (req, res) => {
  // This endpoint is called by the rclone sync cron script
  // Simple shared secret auth since it's loopback only
  const { status, file_count, total_size_bytes, error_message, started_at } = req.body;

  const db = getDb();
  db.prepare(`
    INSERT INTO sync_status (sync_type, status, file_count, total_size_bytes, error_message, started_at)
    VALUES ('gdrive', ?, ?, ?, ?, ?)
  `).run(status, file_count || 0, total_size_bytes || 0, error_message || null, started_at || null);

  res.json({ recorded: true });
});

module.exports = router;
