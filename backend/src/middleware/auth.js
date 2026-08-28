// Genizah — Auth middleware
// Supports local JWT and Authentik SSO tokens

const jwt = require('jsonwebtoken');
const { getDb } = require('../models/database');

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME';

// Verify JWT token from Authorization header
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Try local JWT first
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.id,
      username: decoded.username,
      displayName: decoded.displayName,
      role: decoded.role
    };
    return next();
  } catch (err) {
    // If Authentik is enabled, try validating as an Authentik token
    if (process.env.AUTHENTIK_ENABLED === 'true') {
      return validateAuthentikToken(token, req, res, next);
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Validate token against Authentik userinfo endpoint
async function validateAuthentikToken(token, req, res, next) {
  try {
    const baseUrl = process.env.AUTHENTIK_BASE_URL;
    const response = await fetch(`${baseUrl}/application/o/userinfo/`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid Authentik token' });
    }

    const userInfo = await response.json();
    const db = getDb();

    // Find or create user by Authentik subject ID
    let user = db.prepare('SELECT * FROM users WHERE authentik_sub = ?').get(userInfo.sub);

    if (!user) {
      // Auto-register Authentik users (admin can restrict later)
      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      db.prepare(`
        INSERT INTO users (id, username, display_name, auth_method, authentik_sub, role)
        VALUES (?, ?, ?, 'authentik', ?, 'user')
      `).run(id, userInfo.preferred_username || userInfo.email, userInfo.name || userInfo.email, userInfo.sub);

      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    req.user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    };
    next();
  } catch (err) {
    console.error('[Genizah] Authentik validation error:', err.message);
    return res.status(401).json({ error: 'Authentication failed' });
  }
}

// Require admin role
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Generate JWT for local auth
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

module.exports = { authenticate, requireAdmin, generateToken, JWT_SECRET };
