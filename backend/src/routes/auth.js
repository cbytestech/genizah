// Genizah — Auth routes
// POST /api/auth/login        Local JWT login
// POST /api/auth/register     Create user (admin only)
// GET  /api/auth/me           Current user info
// GET  /api/auth/authentik    Redirect to Authentik
// GET  /api/auth/callback     Authentik OAuth callback
// GET  /api/auth/google/*     Google OAuth (separate router)

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../models/database');
const { authenticate, requireAdmin, generateToken } = require('../middleware/auth');

const router = express.Router();

// Local login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username);

  if (!user || !user.password_hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    }
  });
});

// Get current user
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// Register new user (admin only, or first-run setup)
router.post('/register', (req, res, next) => {
  const db = getDb();
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  // Allow unauthenticated registration only if no users exist (first-run)
  if (userCount > 0) {
    return authenticate(req, res, () => {
      requireAdmin(req, res, () => createUser(req, res));
    });
  }

  // First user becomes admin
  req.firstRun = true;
  createUser(req, res);
});

function createUser(req, res) {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: 'username, password, and displayName required' });
  }

  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  const role = req.firstRun ? 'admin' : 'user';

  db.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, auth_method, role)
    VALUES (?, ?, ?, ?, 'local', ?)
  `).run(id, username, displayName, hash, role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = generateToken(user);

  res.status(201).json({
    token,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    }
  });
}

// Authentik SSO redirect
router.get('/authentik', (req, res) => {
  if (process.env.AUTHENTIK_ENABLED !== 'true') {
    return res.status(404).json({ error: 'SSO not enabled' });
  }

  const params = new URLSearchParams({
    client_id: process.env.AUTHENTIK_CLIENT_ID,
    redirect_uri: process.env.AUTHENTIK_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    state: uuidv4()
  });

  res.redirect(`${process.env.AUTHENTIK_BASE_URL}/application/o/authorize/?${params}`);
});

// Authentik callback
router.get('/callback', async (req, res) => {
  if (process.env.AUTHENTIK_ENABLED !== 'true') {
    return res.status(404).json({ error: 'SSO not enabled' });
  }

  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    // Exchange code for token
    const tokenResponse = await fetch(`${process.env.AUTHENTIK_BASE_URL}/application/o/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.AUTHENTIK_CLIENT_ID,
        client_secret: process.env.AUTHENTIK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.AUTHENTIK_REDIRECT_URI
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      return res.status(401).json({ error: 'Failed to get access token' });
    }

    // Get user info
    const userInfoResponse = await fetch(`${process.env.AUTHENTIK_BASE_URL}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });

    const userInfo = await userInfoResponse.json();
    const db = getDb();

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE authentik_sub = ?').get(userInfo.sub);
    if (!user) {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO users (id, username, display_name, auth_method, authentik_sub, role)
        VALUES (?, ?, ?, 'authentik', ?, 'user')
      `).run(id, userInfo.preferred_username || userInfo.email, userInfo.name || userInfo.email, userInfo.sub);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    const jwt = generateToken(user);

    // Redirect to frontend with token
    res.redirect(`/?token=${jwt}`);
  } catch (err) {
    console.error('[Genizah] Authentik callback error:', err);
    res.status(500).json({ error: 'SSO authentication failed' });
  }
});

// Auth config (tells frontend what's available)
router.get('/config', (req, res) => {
  const { isGoogleEnabled } = require('./google-auth');

  res.json({
    local: true,
    authentik: process.env.AUTHENTIK_ENABLED === 'true',
    authentikUrl: process.env.AUTHENTIK_ENABLED === 'true'
      ? '/api/auth/authentik'
      : null,
    google: isGoogleEnabled(),
    googleUrl: isGoogleEnabled()
      ? '/api/auth/google?action=login'
      : null
  });
});

module.exports = router;
