// Genizah — Tags routes

const express = require('express');
const { getDb } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// List all tags with usage count
router.get('/', (req, res) => {
  const db = getDb();
  const tags = db.prepare(`
    SELECT t.*, COUNT(dt.document_id) as usage_count
    FROM tags t
    LEFT JOIN document_tags dt ON t.id = dt.tag_id
    GROUP BY t.id
    ORDER BY usage_count DESC
  `).all();
  res.json(tags);
});

// Rename a tag
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Tag name required' });
  const trimmed = name.trim().toLowerCase();

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM tags WHERE name = ? AND id != ?').get(trimmed, req.params.id);
  if (existing) return res.status(409).json({ error: 'A tag with that name already exists' });

  db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(trimmed, req.params.id);
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });
  res.json(tag);
});

// Delete a tag (removes from all documents)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) return res.status(404).json({ error: 'Tag not found' });

  db.prepare('DELETE FROM document_tags WHERE tag_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ deleted: true, name: tag.name });
});

module.exports = router;
