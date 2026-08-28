// Genizah — Google OAuth routes (v0.5b)
//
// GET  /api/auth/google              Redirect to Google consent (login or link)
// GET  /api/auth/google/callback     Handle Google's redirect back
// GET  /api/auth/google/status       Check if current user has Google linked
// DELETE /api/auth/google/link       Unlink Google from current user

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { authenticate, generateToken } = require('../middleware/auth');

const router = express.Router();

// In-memory state store (short-lived, cleaned up on use)
const pendingStates = new Map();

// Scopes by action
const BASE_SCOPES = ['openid', 'email', 'profile'];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function isGoogleEnabled() {
  return !!getGoogleConfig();
}

// ── Initiate Google OAuth ──
// Query params:
//   action=login  (sign in with Google, no auth required)
//   action=link   (link to existing account, JWT in Authorization header)
router.get('/', (req, res) => {
  const config = getGoogleConfig();
  if (!config) return res.status(404).json({ error: 'Google OAuth not configured' });

  const action = req.query.action || 'login';
  const state = crypto.randomBytes(24).toString('hex');

  // For linking, extract user from token in query param (since this is a redirect, no header)
  const stateData = { action, created: Date.now() };

  if (action === 'link') {
    // Token passed as query param for the redirect flow
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Token required for linking' });
    stateData.token = token;
  }

  pendingStates.set(state, stateData);

  // Clean up old states (older than 10 minutes)
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of pendingStates) {
    if (v.created < cutoff) pendingStates.delete(k);
  }

  // Determine scopes based on user role (for linking, check the token)
  let scopes = [...BASE_SCOPES, GMAIL_SCOPE];

  if (action === 'link' && stateData.token) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.verify(stateData.token, process.env.JWT_SECRET || 'CHANGE_ME');
      if (decoded.role === 'admin') {
        scopes.push(DRIVE_SCOPE);
      }
      stateData.userId = decoded.id;
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token for linking' });
    }
  }

  // For login, we don't know the role yet, so request base + gmail only
  // Admin can re-link later to get Drive scope, or we check after login

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    access_type: 'offline',    // Get refresh token
    prompt: 'consent'          // Force consent to always get refresh token
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// ── Google Callback ──
router.get('/callback', async (req, res) => {
  const config = getGoogleConfig();
  if (!config) return res.status(404).json({ error: 'Google OAuth not configured' });

  const { code, state, error: googleError } = req.query;

  if (googleError) {
    console.error('[Genizah] Google OAuth error:', googleError);
    return res.redirect('/?google_error=' + encodeURIComponent(googleError));
  }

  if (!code || !state) {
    return res.redirect('/?google_error=missing_params');
  }

  const stateData = pendingStates.get(state);
  if (!stateData) {
    return res.redirect('/?google_error=invalid_state');
  }
  pendingStates.delete(state);

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error('[Genizah] Token exchange failed:', tokens);
      return res.redirect('/?google_error=token_exchange_failed');
    }

    // Get user info from Google
    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const googleUser = await userInfoRes.json();

    if (!googleUser.id || !googleUser.email) {
      return res.redirect('/?google_error=no_user_info');
    }

    const db = getDb();
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Determine granted scopes
    const grantedScopes = tokens.scope || '';

    if (stateData.action === 'link') {
      // ── LINKING: attach Google to existing user ──
      const userId = stateData.userId;
      if (!userId) {
        return res.redirect('/settings?google_error=no_user');
      }

      // Check if this Google account is already linked to someone else
      const existing = db.prepare('SELECT id, username FROM users WHERE google_sub = ?').get(googleUser.id);
      if (existing && existing.id !== userId) {
        return res.redirect('/settings?google_error=already_linked_other');
      }

      db.prepare(`
        UPDATE users SET
          google_sub = ?,
          google_email = ?,
          google_access_token = ?,
          google_refresh_token = COALESCE(?, google_refresh_token),
          google_token_expires = ?,
          google_scopes = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        googleUser.id,
        googleUser.email,
        tokens.access_token,
        tokens.refresh_token || null,
        expiresAt,
        grantedScopes,
        userId
      );

      // Log it
      const { v4: uuidv4 } = require('uuid');
      db.prepare(`
        INSERT INTO activity_log (id, user_id, action, detail)
        VALUES (?, ?, 'google_linked', ?)
      `).run(uuidv4(), userId, `Linked Google account: ${googleUser.email}`);

      return res.redirect('/settings?google_linked=true');
    } else {
      // ── LOGIN: sign in with Google ──
      // Find user by google_sub
      let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleUser.id);

      if (!user) {
        // Try matching by email if someone registered with the same email as username
        user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(google_email) = LOWER(?)').get(googleUser.email, googleUser.email);

        if (!user) {
          // No account found; they need to link first
          return res.redirect('/login?google_error=no_account');
        }

        // Found by email but not linked yet; auto-link
        db.prepare(`
          UPDATE users SET
            google_sub = ?,
            google_email = ?,
            google_access_token = ?,
            google_refresh_token = COALESCE(?, google_refresh_token),
            google_token_expires = ?,
            google_scopes = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          googleUser.id,
          googleUser.email,
          tokens.access_token,
          tokens.refresh_token || null,
          expiresAt,
          grantedScopes,
          user.id
        );
      } else {
        // Update tokens on every sign-in
        db.prepare(`
          UPDATE users SET
            google_access_token = ?,
            google_refresh_token = COALESCE(?, google_refresh_token),
            google_token_expires = ?,
            google_scopes = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          tokens.access_token,
          tokens.refresh_token || null,
          expiresAt,
          grantedScopes,
          user.id
        );
      }

      // Issue a JWT
      const jwt = generateToken(user);
      return res.redirect(`/?token=${jwt}`);
    }
  } catch (err) {
    console.error('[Genizah] Google callback error:', err);
    return res.redirect('/?google_error=server_error');
  }
});

// ── Check Google link status ──
router.get('/status', authenticate, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT google_sub, google_email, google_scopes FROM users WHERE id = ?').get(req.user.id);

  if (!user || !user.google_sub) {
    return res.json({ linked: false });
  }

  res.json({
    linked: true,
    email: user.google_email,
    scopes: user.google_scopes || '',
    hasDrive: (user.google_scopes || '').includes('drive.file'),
    hasGmail: (user.google_scopes || '').includes('gmail.readonly')
  });
});

// ── Unlink Google ──
router.delete('/link', authenticate, (req, res) => {
  const db = getDb();

  // Make sure user still has a password (don't lock them out)
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.password_hash) {
    return res.status(400).json({
      error: 'Cannot unlink Google without a local password. Set a password first.'
    });
  }

  db.prepare(`
    UPDATE users SET
      google_sub = NULL,
      google_email = NULL,
      google_access_token = NULL,
      google_refresh_token = NULL,
      google_token_expires = NULL,
      google_scopes = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id);

  const { v4: uuidv4 } = require('uuid');
  db.prepare(`
    INSERT INTO activity_log (id, user_id, action, detail)
    VALUES (?, ?, 'google_unlinked', 'Unlinked Google account')
  `).run(uuidv4(), req.user.id);

  res.json({ success: true });
});

module.exports = router;
module.exports.isGoogleEnabled = isGoogleEnabled;
