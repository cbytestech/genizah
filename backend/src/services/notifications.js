// Genizah — Notification service
// Activity logging, Ntfy push alerts, expiration warnings

const { v4: uuidv4 } = require('uuid');

// Log activity to the database
function logActivity(userId, documentId, action, detail) {
  try {
    const { getDb } = require('../models/database');
    const db = getDb();
    db.prepare(`
      INSERT INTO activity_log (id, user_id, document_id, action, detail)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), userId, documentId, action, detail);
  } catch (err) {
    console.error('[Genizah] Activity log error:', err.message);
  }
}

// Send Ntfy notification to all OTHER users (not the one who triggered it)
async function notifyUsers(triggeringUser, action, message) {
  if (process.env.NTFY_ENABLED !== 'true') return;

  const ntfyUrl = process.env.NTFY_BASE_URL || 'http://127.0.0.1:8090';
  const topic = process.env.NTFY_TOPIC || 'genizah';

  // Map actions to priority and tags
  const config = {
    uploaded: { priority: '3', tags: 'page_facing_up' },
    viewed: { priority: '1', tags: 'eyes' },           // low priority, just FYI
    edited: { priority: '3', tags: 'pencil2' },
    deleted: { priority: '4', tags: 'wastebasket' },
    expired_warning: { priority: '4', tags: 'warning' },
    shared: { priority: '3', tags: 'link' }
  };

  const { priority, tags } = config[action] || { priority: '3', tags: 'bell' };

  try {
    await fetch(`${ntfyUrl}/${topic}`, {
      method: 'POST',
      headers: {
        'Title': `Genizah: ${action}`,
        'Priority': priority,
        'Tags': tags
      },
      body: message
    });
  } catch (err) {
    console.error('[Genizah] Ntfy error:', err.message);
  }
}

// Daily check for documents expiring within 30 days
function startExpirationChecker() {
  const checkInterval = 24 * 60 * 60 * 1000; // 24 hours

  async function check() {
    try {
      const { getDb } = require('../models/database');
      const db = getDb();

      // Find active documents expiring within 30 days
      const expiring = db.prepare(`
        SELECT d.*, o.name as owner_name
        FROM documents d
        LEFT JOIN owners o ON d.owner_id = o.id
        WHERE d.status = 'active'
          AND d.expiration_date IS NOT NULL
          AND d.expiration_date <= date('now', '+30 days')
          AND d.expiration_date >= date('now')
        ORDER BY d.expiration_date ASC
      `).all();

      if (expiring.length === 0) return;

      // Group by urgency
      const urgent = expiring.filter(d => {
        const days = Math.ceil((new Date(d.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
        return days <= 7;
      });
      const upcoming = expiring.filter(d => {
        const days = Math.ceil((new Date(d.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
        return days > 7;
      });

      // Send consolidated notification
      let message = '';
      if (urgent.length > 0) {
        message += `⚠️ EXPIRING THIS WEEK:\n`;
        for (const d of urgent) {
          const days = Math.ceil((new Date(d.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
          message += `  • ${d.title} (${d.owner_name}) — ${days} day${days !== 1 ? 's' : ''}\n`;
        }
      }
      if (upcoming.length > 0) {
        message += `📋 Expiring within 30 days:\n`;
        for (const d of upcoming) {
          const days = Math.ceil((new Date(d.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
          message += `  • ${d.title} (${d.owner_name}) — ${days} days\n`;
        }
      }

      // Log each as activity
      for (const d of expiring) {
        const days = Math.ceil((new Date(d.expiration_date) - new Date()) / (1000 * 60 * 60 * 24));
        logActivity('system', d.id, 'expired_warning',
          `"${d.title}" expires in ${days} day${days !== 1 ? 's' : ''}`);
      }

      // Send Ntfy alert
      await notifyUsers({ id: 'system' }, 'expired_warning', message.trim());

      console.log(`[Genizah] Expiration check: ${expiring.length} documents expiring within 30 days`);
    } catch (err) {
      console.error('[Genizah] Expiration check error:', err.message);
    }
  }

  // Run once on startup (after a short delay for DB init), then every 24h
  setTimeout(check, 10000);
  setInterval(check, checkInterval);

  console.log('[Genizah] Expiration checker started (daily)');
}

module.exports = { logActivity, notifyUsers, startExpirationChecker };
