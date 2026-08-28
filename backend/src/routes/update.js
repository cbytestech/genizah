// Genizah — Self-update routes
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const { authenticate } = require('../middleware/auth');
const { logActivity, notifyUsers } = require('../services/notifications');

const router = express.Router();
router.use(authenticate);

const uploadDir = '/tmp/genizah-patches';
const upload = multer({ dest: uploadDir, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

// Upload and preview a patch (does NOT apply it yet)
router.post('/upload', upload.single('patch'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const extractDir = path.join(uploadDir, 'extracted-' + Date.now());
    fs.mkdirSync(extractDir, { recursive: true });

    // Extract tar.gz
    execSync(`tar xzf "${req.file.path}" -C "${extractDir}"`, { timeout: 30000 });

    // Check for deploy.sh
    const hasDeployScript = fs.existsSync(path.join(extractDir, 'deploy.sh'));

    // List the files in the patch
    const files = [];
    function walkDir(dir, prefix) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) {
          walkDir(path.join(dir, entry.name), relPath);
        } else {
          const stat = fs.statSync(path.join(dir, entry.name));
          files.push({ path: relPath, size: stat.size });
        }
      }
    }
    walkDir(extractDir, '');

    // Read deploy.sh content for preview
    let deployScript = null;
    if (hasDeployScript) {
      deployScript = fs.readFileSync(path.join(extractDir, 'deploy.sh'), 'utf-8');
    }

    // Clean up the uploaded file but keep extracted
    fs.unlinkSync(req.file.path);

    res.json({
      extractDir,
      hasDeployScript,
      files,
      deployScript,
      fileCount: files.length
    });
  } catch (err) {
    // Clean up on error
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.status(500).json({ error: 'Failed to extract patch: ' + err.message });
  }
});

// Apply a previously uploaded patch
router.post('/apply', (req, res) => {
  const { extractDir } = req.body;
  if (!extractDir || !extractDir.startsWith(uploadDir)) {
    return res.status(400).json({ error: 'Invalid patch directory' });
  }
  if (!fs.existsSync(extractDir)) {
    return res.status(404).json({ error: 'Patch not found. Upload again.' });
  }

  const hostSource = '/app/host-source';
  if (!fs.existsSync(hostSource)) {
    return res.status(500).json({ error: 'Host source directory not mounted. Check docker-compose.yml volumes.' });
  }

  // Extract version/changelog from deploy.sh for activity log
  let patchVersion = 'unknown';
  let changelogLines = [];
  const deployScript = path.join(extractDir, 'deploy.sh');
  if (fs.existsSync(deployScript)) {
    const scriptContent = fs.readFileSync(deployScript, 'utf-8');
    // Look for commit message like: git commit -m "v0.4.1 - description"
    const commitMatch = scriptContent.match(/git commit -m ["']([^"']+)["']/);
    if (commitMatch) patchVersion = commitMatch[1];
    // Look for echo lines after "New" or "features" or "What"
    const echoMatches = scriptContent.match(/echo\s+"?\s*\*\s+(.+?)["']?\s*$/gm);
    if (echoMatches) {
      changelogLines = echoMatches.map(line => {
        return line.replace(/echo\s+"?\s*\*\s+/, '').replace(/["']\s*$/, '').trim();
      });
    }
  }

  // Log update to activity feed
  const changelogText = changelogLines.length > 0 ? '\n' + changelogLines.map(l => '• ' + l).join('\n') : '';
  logActivity(req.user.id, null, 'updated', '🔄 ' + req.user.displayName + ' updated Genizah: ' + patchVersion + changelogText);
  notifyUsers(req.user, 'updated', '🔄 System updated: ' + patchVersion);

  // Send response immediately — the rebuild will kill this container
  res.json({ status: 'applying', message: 'Patch is being applied. The app will restart in a few seconds.' });

  // Run the update in the background after response is sent
  setTimeout(() => {
    try {
      if (fs.existsSync(deployScript)) {
        // Copy all files except deploy.sh to host source, preserving structure
        copyPatchFiles(extractDir, hostSource);

        // Git commit from inside container (host-source is bind-mounted)
        try {
          execSync('cd /app/host-source && git add -A && git commit -m "Patch applied via web UI" || true', {
            timeout: 30000,
            stdio: 'ignore'
          });
        } catch (e) { /* git commit is best-effort */ }

        // Trigger rebuild using Docker socket
        const rebuild = spawn('docker', ['compose', '-f', '/app/host-source/docker-compose.yml', 'up', '-d', '--build'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, COMPOSE_PROJECT_NAME: 'genizah' }
        });
        rebuild.unref();
      }
    } catch (err) {
      console.error('Patch apply error:', err);
    }
  }, 500);
});

// Get current version info
router.get('/version', (req, res) => {
  let version = 'unknown';
  let lastCommit = 'unknown';

  try {
    // Try reading from git in host-source
    version = execSync('cd /app/host-source && git log -1 --format="%s" 2>/dev/null || echo "unknown"', { timeout: 5000 }).toString().trim();
    lastCommit = execSync('cd /app/host-source && git log -1 --format="%ci" 2>/dev/null || echo "unknown"', { timeout: 5000 }).toString().trim();
  } catch (e) {}

  res.json({ version, lastCommit });
});

function copyPatchFiles(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'deploy.sh') continue; // Skip the deploy script itself

    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // Map patch directory structure to project structure
      // Patch dirs like "backend/src/routes" map directly to project
      fs.mkdirSync(destPath, { recursive: true });
      copyPatchFiles(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = router;
