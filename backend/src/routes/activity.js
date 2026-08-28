// Genizah — Activity feed routes

const express = require('express');
const { getDb } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Get activity feed
router.get('/', (req, res) => {
  const { limit, before, action } = req.query;
  const pageSize = Math.min(50, Math.max(1, parseInt(limit) || 20));

  const db = getDb();
  const conditions = [];
  const params = [];

  if (before) { conditions.push('a.created_at < ?'); params.push(before); }
  if (action) { conditions.push('a.action = ?'); params.push(action); }

  // Don't include low-value browse events in default feed
  if (!action) { conditions.push("a.action != 'viewed'"); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const activities = db.prepare(`
    SELECT a.*,
      u.display_name as user_name,
      d.title as document_title
    FROM activity_log a
    LEFT JOIN users u ON a.user_id = u.id
    LEFT JOIN documents d ON a.document_id = d.id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(...params, pageSize);

  res.json(activities);
});

module.exports = router;
