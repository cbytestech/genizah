#!/bin/bash
# Genizah — Tank Deployment Script
# Run this on Tank after extracting the project to /opt/genizah
#
# Usage: sudo bash deploy.sh

set -euo pipefail

echo "========================================"
echo "  GENIZAH — Deployment Script"
echo "  Digital Filing Cabinet"
echo "========================================"
echo ""

INSTALL_DIR="/opt/genizah"

# Check we're in the right place
if [ ! -f "${INSTALL_DIR}/docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found in ${INSTALL_DIR}"
  echo "Make sure you extracted the project to /opt/genizah first."
  exit 1
fi

cd "${INSTALL_DIR}"

# ── Step 1: Create data directories ──
echo "[1/7] Creating data directories..."
mkdir -p /opt/genizah/db
mkdir -p /opt/genizah/files
mkdir -p /opt/genizah/thumbnails
mkdir -p /opt/genizah/config
mkdir -p /opt/genizah/backups
echo "  ✓ Directories created"

# ── Step 2: Generate .env if it doesn't exist ──
echo ""
echo "[2/7] Setting up environment..."
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  cp "${INSTALL_DIR}/.env.example" "${INSTALL_DIR}/.env"

  # Generate a random JWT secret
  JWT_SECRET=$(openssl rand -base64 40)
  sed -i "s|JWT_SECRET=CHANGE_ME_GENERATE_WITH_OPENSSL|JWT_SECRET=${JWT_SECRET}|" "${INSTALL_DIR}/.env"

  echo "  ✓ .env created with auto-generated JWT secret"
  echo ""
  echo "  ╔══════════════════════════════════════════╗"
  echo "  ║  MANUAL STEP NEEDED:                      ║"
  echo "  ║  Edit /opt/genizah/.env and fill in:       ║"
  echo "  ║    - SOFER_API_TOKEN (Paperless-ngx token) ║"
  echo "  ║    - NTFY settings (if different)          ║"
  echo "  ║    - Authentik settings (if using SSO)     ║"
  echo "  ╚══════════════════════════════════════════╝"
  echo ""
  read -p "  Press Enter when you've updated .env (or Enter to skip for now)..."
else
  echo "  ✓ .env already exists, skipping"
fi

# ── Step 3: Install frontend dependencies and build ──
echo ""
echo "[3/7] Building frontend..."
cd "${INSTALL_DIR}/frontend"

# Check if node is available
if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js not found. Install it first."
  exit 1
fi

npm install --no-audit --no-fund 2>&1 | tail -1
npm run build 2>&1 | tail -3
echo "  ✓ Frontend built to frontend/dist/"

# ── Step 4: Install backend dependencies ──
echo ""
echo "[4/7] Installing backend dependencies..."
cd "${INSTALL_DIR}/backend"
npm install --no-audit --no-fund 2>&1 | tail -1
echo "  ✓ Backend dependencies installed"

# ── Step 5: Copy frontend build into backend for serving ──
echo ""
echo "[5/7] Packaging frontend into backend..."
rm -rf "${INSTALL_DIR}/backend/public"
cp -r "${INSTALL_DIR}/frontend/dist" "${INSTALL_DIR}/backend/public"
echo "  ✓ Frontend copied to backend/public/"

# ── Step 6: Test that the app starts ──
echo ""
echo "[6/7] Quick startup test..."
cd "${INSTALL_DIR}/backend"

# Source .env for the test
set -a
source "${INSTALL_DIR}/.env"
set +a

# Test that it starts (run for 3 seconds then kill)
timeout 4 node src/index.js &
TEST_PID=$!
sleep 3

if kill -0 $TEST_PID 2>/dev/null; then
  echo "  ✓ App starts successfully on port ${PORT:-3090}"
  kill $TEST_PID 2>/dev/null || true
  wait $TEST_PID 2>/dev/null || true
else
  echo "  ⚠ App may have issues. Check the output above."
fi

# ── Step 7: Start with Docker (or direct) ──
echo ""
echo "[7/7] Starting Genizah..."
echo ""
echo "  Choose how to run:"
echo "  1) Direct (node process, good for testing)"
echo "  2) Docker Compose (production)"
echo "  3) Skip (I'll start it manually)"
echo ""
read -p "  Enter choice [1/2/3]: " RUN_CHOICE

case $RUN_CHOICE in
  1)
    echo ""
    echo "  Starting directly... (Ctrl+C to stop)"
    echo "  Access at http://$(hostname -I | awk '{print $1}'):${PORT:-3090}"
    echo ""
    cd "${INSTALL_DIR}/backend"
    set -a; source "${INSTALL_DIR}/.env"; set +a
    node src/index.js
    ;;
  2)
    echo ""
    cd "${INSTALL_DIR}"
    docker compose up -d --build
    echo ""
    echo "  ✓ Genizah running in Docker"
    echo "  Access at http://$(hostname -I | awk '{print $1}'):3090"
    docker compose logs --tail 10
    ;;
  3)
    echo ""
    echo "  Skipped. Start manually with:"
    echo "    cd /opt/genizah && docker compose up -d --build"
    echo "  or:"
    echo "    cd /opt/genizah/backend && node src/index.js"
    ;;
esac

echo ""
echo "========================================"
echo "  NEXT STEPS:"
echo "  1. Open http://YOUR_SERVER_IP:3090"
echo "  2. Create your admin account (first user = admin)"
echo "  3. Create Emily's account"
echo "  4. Set up Apache reverse proxy (see below)"
echo "  5. Scan your first document!"
echo ""
echo "  Apache proxy config:"
echo "    vault.cookiebytestech.com -> localhost:3090"
echo "========================================"
