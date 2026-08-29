// Gmail Scan API Routes
// Endpoints for manual scan trigger, status, history, and sender rules

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/database');
const { authenticateToken } = require('../middleware/auth');
const { scanUserGmail } = require('../services/gmailScanner');

// All routes require auth
router.use(authenticateToken);

// ── POST /api/gmail-scan/trigger ────────────────────────────────────────
// Manual scan: checks last 7 days, available to any linked user

router.post('/trigger', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!user.google_refresh_token || !user.google_scopes?.includes('gmail.readonly')) {
      return res.status(400).json({
        error: 'Gmail not linked. Link your Google account in Settings first.'
      });
    }

    // Check for already-running scan
    const running = db.prepare(`
      SELECT id FROM gmail_scan_runs
      WHERE user_id = ? AND status = 'running'
    `).get(user.id);

    if (running) {
      return res.status(409).json({ error: 'A scan is already running.' });
    }

    // Fire and forget: scan runs in background, client polls for status
    res.json({ message: 'Scan started', scan_type: 'manual' });

    // Run scan after response is sent
    scanUserGmail(user, 'manual').catch(e => {
      console.error('[Gmail Scan Route] Manual scan error:', e.message);
    });

  } catch (e) {
    console.error('[Gmail Scan Route] Trigger error:', e.message);
    res.status(500).json({ error: 'Failed to start scan' });
  }
});

// ── GET /api/gmail-scan/status ──────────────────────────────────────────
// Current scan status for the authenticated user

router.get('/status', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    const hasGmail = !!(user.google_refresh_token && user.google_scopes?.includes('gmail.readonly'));

    // Most recent run
    const lastRun = db.prepare(`
      SELECT * FROM gmail_scan_runs
      WHERE user_id = ?
      ORDER BY started_at DESC LIMIT 1
    `).get(req.user.id);

    // Running scan?
    const isRunning = db.prepare(`
      SELECT id FROM gmail_scan_runs
      WHERE user_id = ? AND status = 'running'
    `).get(req.user.id);

    // Stats: total documents created from Gmail
    const totalCreated = db.prepare(`
      SELECT COUNT(*) as count FROM gmail_processed
      WHERE user_id = ? AND status = 'processed' AND document_id IS NOT NULL
    `).get(req.user.id);

    // Recent scans summary (last 24 hours)
    const recentStats = db.prepare(`
      SELECT
        SUM(documents_created) as created,
        SUM(duplicates_skipped) as duplicates,
        SUM(errors) as errors,
        COUNT(*) as runs
      FROM gmail_scan_runs
      WHERE user_id = ? AND started_at > datetime('now', '-1 day')
    `).get(req.user.id);

    // Blocked sender count
    const blockedCount = db.prepare(`
      SELECT COUNT(*) as count FROM gmail_sender_rules
      WHERE user_id = ? AND action = 'block'
    `).get(req.user.id);

    res.json({
      gmail_linked: hasGmail,
      is_running: !!isRunning,
      last_run: lastRun || null,
      total_documents: totalCreated?.count || 0,
      recent_24h: {
        runs: recentStats?.runs || 0,
        created: recentStats?.created || 0,
        duplicates: recentStats?.duplicates || 0,
        errors: recentStats?.errors || 0,
      },
      blocked_senders: blockedCount?.count || 0,
    });
  } catch (e) {
    console.error('[Gmail Scan Route] Status error:', e.message);
    res.status(500).json({ error: 'Failed to get scan status' });
  }
});

// ── GET /api/gmail-scan/history ─────────────────────────────────────────
// Recent scan runs for the authenticated user

router.get('/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const runs = db.prepare(`
      SELECT * FROM gmail_scan_runs
      WHERE user_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(req.user.id, limit);

    res.json({ runs });
  } catch (e) {
    console.error('[Gmail Scan Route] History error:', e.message);
    res.status(500).json({ error: 'Failed to get scan history' });
  }
});

// ── GET /api/gmail-scan/rules ───────────────────────────────────────────
// Sender rules (whitelist/blacklist) for the authenticated user

router.get('/rules', (req, res) => {
  try {
    const rules = db.prepare(`
      SELECT * FROM gmail_sender_rules
      WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);

    res.json({ rules });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get sender rules' });
  }
});

// ── POST /api/gmail-scan/rules ──────────────────────────────────────────
// Add a sender rule

router.post('/rules', (req, res) => {
  try {
    const { sender_email, sender_name, action } = req.body;

    if (!sender_email) {
      return res.status(400).json({ error: 'sender_email is required' });
    }

    const validActions = ['allow', 'block'];
    const ruleAction = validActions.includes(action) ? action : 'block';

    db.prepare(`
      INSERT OR REPLACE INTO gmail_sender_rules (user_id, sender_email, sender_name, action)
      VALUES (?, ?, ?, ?)
    `).run(req.user.id, sender_email.toLowerCase(), sender_name || null, ruleAction);

    // Log it
    db.prepare(`
      INSERT INTO activity_log (id, user_id, action, detail, created_at)
      VALUES (?, ?, 'gmail_sender_rule', ?, datetime('now'))
    `).run(crypto.randomUUID(), req.user.id, JSON.stringify({ sender_email, action: ruleAction }));

    res.json({ message: `Sender ${ruleAction}ed`, sender_email });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add sender rule' });
  }
});

// ── DELETE /api/gmail-scan/rules/:id ────────────────────────────────────
// Remove a sender rule

router.delete('/rules/:id', (req, res) => {
  try {
    const rule = db.prepare(
      'SELECT * FROM gmail_sender_rules WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);

    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    db.prepare('DELETE FROM gmail_sender_rules WHERE id = ?').run(req.params.id);

    res.json({ message: 'Rule removed', sender_email: rule.sender_email });
  } catch (e) {
    res.status(500).json({ error: 'Failed to remove rule' });
  }
});

// ── GET /api/gmail-scan/recent-senders ──────────────────────────────────
// Show recent senders from processed emails (helps user build block list)

router.get('/recent-senders', (req, res) => {
  try {
    const senders = db.prepare(`
      SELECT sender, COUNT(*) as count, MAX(email_date) as last_seen,
             SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) as processed,
             SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
      FROM gmail_processed
      WHERE user_id = ?
      GROUP BY sender
      ORDER BY count DESC
      LIMIT 50
    `).all(req.user.id);

    // Annotate with current rule status
    const rules = db.prepare(
      'SELECT sender_email, action FROM gmail_sender_rules WHERE user_id = ?'
    ).all(req.user.id);
    const ruleMap = new Map(rules.map(r => [r.sender_email, r.action]));

    const annotated = senders.map(s => ({
      ...s,
      rule: ruleMap.get(s.sender) || 'none',
    }));

    res.json({ senders: annotated });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get recent senders' });
  }
});

module.exports = router;
