// Genizah — Digital Filing Cabinet
// Entry point

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createApp } = require('./config/app');
const { getDb, closeDb } = require('./models/database');
const { startExpirationChecker } = require('./services/notifications');
const { initBackupScheduler } = require('./services/backupRunner');
const cron = require('node-cron');
const { initGmailScanTables, runScheduledScan } = require('./services/gmailScanner');

const PORT = process.env.PORT || 3090;

// Initialize database on startup
getDb();
console.log('[Genizah] Database initialized');

// Start the expiration checker (daily scan for expiring documents)
startExpirationChecker();

// Gmail Receipt Scanner tables
initGmailScanTables();

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[Genizah] Listening on port ${PORT}`);
  console.log(`[Genizah] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Genizah] Authentik SSO: ${process.env.AUTHENTIK_ENABLED === 'true' ? 'enabled' : 'disabled'}`);
  console.log(`[Genizah] Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? 'enabled' : 'disabled'}`);

  // Start Google Drive backup scheduler
  initBackupScheduler();

  // Gmail Receipt Scanner: every 15 min, handler gates to 7 AM - 10 PM Central
  cron.schedule('*/15 * * * *', () => {
    runScheduledScan().catch(e => console.error('[Cron] Gmail scan error:', e.message));
  });
  console.log('[Scheduler] Gmail receipt scanner active (every 15 min, 7a-10p Central)');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Genizah] SIGTERM received, shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Genizah] SIGINT received, shutting down...');
  server.close(() => {
    closeDb();
    process.exit(0);
  });
});
