// Genizah — Document types routes

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', (req, res) => {
  const db = getDb();
  const types = db.prepare('SELECT * FROM document_types ORDER BY sort_order ASC').all();
  res.json(types);
});

router.post('/', requireAdmin, (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const db = getDb();
  const id = `type-${name.toLowerCase().replace(/\s+/g, '-')}`;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM document_types').get().m || 0;

  db.prepare('INSERT INTO document_types (id, name, icon, sort_order) VALUES (?, ?, ?, ?)')
    .run(id, name, icon || '📄', maxOrder + 1);

  res.status(201).json(db.prepare('SELECT * FROM document_types WHERE id = ?').get(id));
});

module.exports = router;
