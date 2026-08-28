// Genizah — Owners routes
// GET  /api/owners       List all owners
// POST /api/owners       Create owner (admin)
// PATCH /api/owners/:id  Update owner (admin)

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', (req, res) => {
  const db = getDb();
  const owners = db.prepare('SELECT * FROM owners ORDER BY sort_order ASC').all();
  res.json(owners);
});

router.post('/', requireAdmin, (req, res) => {
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const db = getDb();
  const id = `owner-${name.toLowerCase().replace(/\s+/g, '-')}`;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM owners').get().m || 0;

  db.prepare('INSERT INTO owners (id, name, color, icon, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, color || '#888888', icon || '📁', maxOrder + 1);

  res.status(201).json(db.prepare('SELECT * FROM owners WHERE id = ?').get(id));
});

router.patch('/:id', requireAdmin, (req, res) => {
  const db = getDb();
  const { name, color, icon } = req.body;
  const updates = [];
  const params = [];

  if (name) { updates.push('name = ?'); params.push(name); }
  if (color) { updates.push('color = ?'); params.push(color); }
  if (icon) { updates.push('icon = ?'); params.push(icon); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE owners SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json(db.prepare('SELECT * FROM owners WHERE id = ?').get(req.params.id));
});

module.exports = router;
