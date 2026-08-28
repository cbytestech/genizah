#!/bin/bash
# Genizah v0.2.1 Patch — Bug Fixes
# Run on Tank: cd /opt/genizah && sudo bash patch-v0.2.1.sh
#
# Fixes:
#   Issue #1: Owner field blank on document detail view
#   Issue #2: Images not rendering (JWT auth blocking img tags)
#   Issue #3: Upload error (already fixed in v0.2, rebuild confirms)

set -euo pipefail
GENIZAH="/opt/genizah"

echo "=== Genizah v0.2.1 Patch ==="
echo ""
echo "Fixes:"
echo "  #1  Owner field blank on document detail"
echo "  #2  Images not rendering (auth removed from /files route)"
echo "  #3  Upload redirect (confirmed fixed, rebuild clears stale build)"
echo ""

# Pull latest from GitHub
echo "[1/3] Pulling latest from GitHub..."
cd "$GENIZAH"
git pull origin main

# Stop container
echo "[2/3] Stopping container..."
docker compose down 2>/dev/null || true

# Rebuild and start
echo "[3/3] Rebuilding container..."
docker compose up -d --build

echo ""
echo "=== Patch Complete ==="
echo "Genizah v0.2.1 is live."
echo ""
echo "What changed:"
echo "  * Document detail now shows all owners (multi-owner badges)"
echo "  * Edit form uses owner chips instead of dropdown (matches scan page)"
echo "  * Images load on document detail (auth removed from /files route)"
echo "  * Rebuild clears any stale frontend build artifacts"
echo ""
echo "Test it:"
echo "  1. Open a document — owner badges should show, image should render"
echo "  2. Edit a document — owner selection uses tappable chips"
echo "  3. Upload a new document — should redirect to detail view cleanly"
echo ""
