/**
 * backup.js -- API routes for Google Drive backup
 * All endpoints require admin role.
 */

const express = require('express');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { runBackup, getBackupStatus, getBackupHistory, isBackupRunning } = require('../services/backupRunner');

const router = express.Router();
router.use(authenticate);
router.use(requireAdmin);

/** GET /api/backup/status */
router.get('/status', (req, res) => {
  try {
    const status = getBackupStatus();
    res.json(status);
  } catch (err) {
    console.error('[Backup API] Status error:', err.message);
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

/** POST /api/backup/run -- trigger manual backup */
router.post('/run', (req, res) => {
  if (isBackupRunning()) {
    return res.status(409).json({ error: 'A backup is already in progress' });
  }

  res.status(202).json({ message: 'Backup started', started_at: new Date().toISOString() });

  // Run async (don't await in request handler)
  runBackup().catch(err => {
    console.error('[Backup API] Async backup error:', err.message);
  });
});

/** GET /api/backup/history */
router.get('/history', (req, res) => {
  try {
    let limit = parseInt(req.query.limit) || 20;
    if (limit > 50) limit = 50;
    if (limit < 1) limit = 1;
    const history = getBackupHistory(limit);
    res.json({ runs: history, count: history.length });
  } catch (err) {
    console.error('[Backup API] History error:', err.message);
    res.status(500).json({ error: 'Failed to get backup history' });
  }
});

module.exports = router;
