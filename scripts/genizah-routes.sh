#!/bin/bash
# genizah-routes.sh — List all registered Express routes for Claude context
# Usage: bash /opt/genizah/scripts/genizah-routes.sh
#
# Parses route files directly (no app startup needed)

PROJ="${1:-/opt/genizah}"
ROUTES_DIR="$PROJ/backend/src/routes"

echo "=== Genizah API Routes ==="
echo "Generated: $(date -Iseconds)"
echo ""

# 1. Find route mounts from index.js (maps prefix → file)
echo "── Route Mounts (from index.js) ──"
grep -E "app\.use\(.*require" "$PROJ/backend/src/index.js" 2>/dev/null \
  | sed "s/.*app\.use('\([^']*\)'.*require('\([^']*\)').*/  \1  →  \2/" \
  || echo "  (could not parse index.js)"
echo ""

# 2. Parse each route file for HTTP methods
echo "── Endpoints by File ──"
for file in "$ROUTES_DIR"/*.js; do
  [ -f "$file" ] || continue
  basename=$(basename "$file" .js)
  
  # Count routes in file
  count=$(grep -cE 'router\.(get|post|put|patch|delete)\(' "$file" 2>/dev/null || echo 0)
  echo ""
  echo "📁 $basename.js ($count routes)"
  echo "   ────────────────────────────"
  
  # Extract: router.get('/path', ...) → GET /path
  grep -nE 'router\.(get|post|put|patch|delete)\(' "$file" 2>/dev/null \
    | while IFS= read -r line; do
      lineno=$(echo "$line" | cut -d: -f1)
      method=$(echo "$line" | grep -oE '\.(get|post|put|patch|delete)\(' | tr -d '.(' | tr 'a-z' 'A-Z')
      path=$(echo "$line" | grep -oE "'[^']*'" | head -1 | tr -d "'")
      
      # Try to grab the comment above the route (1-2 lines back)
      comment=""
      prev=$(sed -n "$((lineno-1))p" "$file" 2>/dev/null)
      if echo "$prev" | grep -qE '^\s*(//|/\*|\*)'; then
        comment=$(echo "$prev" | sed 's/.*\/\/\s*//' | sed 's/.*\*\s*//' | head -c 60)
      fi
      
      printf "   %-7s %-30s %s\n" "$method" "$path" "$comment"
    done
done

echo ""
echo "── Summary ──"
total=$(grep -rE 'router\.(get|post|put|patch|delete)\(' "$ROUTES_DIR"/*.js 2>/dev/null | wc -l)
gets=$(grep -rcE 'router\.get\(' "$ROUTES_DIR"/*.js 2>/dev/null | awk -F: '{s+=$2}END{print s}')
posts=$(grep -rcE 'router\.post\(' "$ROUTES_DIR"/*.js 2>/dev/null | awk -F: '{s+=$2}END{print s}')
patches=$(grep -rcE 'router\.patch\(' "$ROUTES_DIR"/*.js 2>/dev/null | awk -F: '{s+=$2}END{print s}')
puts=$(grep -rcE 'router\.put\(' "$ROUTES_DIR"/*.js 2>/dev/null | awk -F: '{s+=$2}END{print s}')
deletes=$(grep -rcE 'router\.delete\(' "$ROUTES_DIR"/*.js 2>/dev/null | awk -F: '{s+=$2}END{print s}')
echo "Total: $total routes (GET:$gets POST:$posts PATCH:$patches PUT:$puts DELETE:$deletes)"
echo "Files: $(ls "$ROUTES_DIR"/*.js 2>/dev/null | wc -l) route files"
