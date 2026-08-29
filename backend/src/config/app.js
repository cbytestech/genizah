const express = require('express');
const cors = require('cors');
const path = require('path');

function createApp() {
  const app = express();

  app.use(cors({
    origin: process.env.NODE_ENV === 'production'
      ? 'https://vault.cookiebytestech.com'
      : ['http://localhost:5173', 'http://localhost:3090'],
    credentials: true
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/auth/google', require('../routes/google-auth'));
  app.use('/api/documents', require('../routes/documents'));
  app.use('/api/owners', require('../routes/owners'));
  app.use('/api/types', require('../routes/types'));
  app.use('/api/tags', require('../routes/tags'));
  app.use('/api/activity', require('../routes/activity'));
  app.use('/api/sync', require('../routes/sync'));
  app.use('/api/backup', require('../routes/backup'));
  app.use('/api/gmail-scan', require('../routes/gmail-scan'));
  app.use('/api/update', require('../routes/update'));

  // Thumbnails: no auth (small previews, loaded by img tags)
  app.use('/thumbnails', express.static(
    process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails')
  ));

  // Full files: no auth (same as thumbnails — img tags can't send JWT headers;
  // files use UUID paths so they aren't guessable, and the app is behind SSL)
  app.use('/files', express.static(
    process.env.UPLOAD_PATH || path.join(__dirname, '../../data/files')
  ));

  const publicPath = path.join(__dirname, '../public');
  app.use(express.static(publicPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/files/') && !req.path.startsWith('/thumbnails/')) {
      res.sendFile(path.join(publicPath, 'index.html'));
    }
  });

  app.use((err, req, res, next) => {
    console.error('[Genizah Error]', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
