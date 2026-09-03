#!/bin/bash
# genizah-tree.sh — Print project structure for Claude context
# Usage: bash /opt/genizah/scripts/genizah-tree.sh [depth]
#
# Skips node_modules, .git, dist, data, thumbnails, uploads

PROJ="${1:-/opt/genizah}"
DEPTH="${2:-4}"

echo "=== Genizah Project Tree (depth $DEPTH) ==="
echo "Generated: $(date -Iseconds)"
echo ""

find "$PROJ" \
  -maxdepth "$DEPTH" \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/dist/*' \
  -not -path '*/data/files/*' -not -path '*/files/*' \
  -not -path '*/data/thumbnails/*' -not -path '*/data/files/*' -not -path '*/files/*' \
  -not -path '*/data/db/*' \
  -not -path '*/.cache/*' \
  -not -name '*.bak-*' \
  -not -name 'package-lock.json' \
  | sort \
  | while IFS= read -r entry; do
    # Calculate depth for indentation
    rel="${entry#$PROJ}"
    depth=$(echo "$rel" | tr -cd '/' | wc -c)
    indent=$(printf '%*s' "$((depth * 2))" '')

    if [ -d "$entry" ]; then
      basename=$(basename "$entry")
      echo "${indent}📁 ${basename}/"
    else
      basename=$(basename "$entry")
      size=$(stat -c%s "$entry" 2>/dev/null || echo "?")
      if [ "$size" != "?" ] && [ "$size" -gt 1048576 ]; then
        size_fmt="$(echo "scale=1; $size/1048576" | bc)M"
      elif [ "$size" != "?" ] && [ "$size" -gt 1024 ]; then
        size_fmt="$(echo "scale=1; $size/1024" | bc)K"
      else
        size_fmt="${size}B"
      fi
      echo "${indent}  ${basename}  (${size_fmt})"
    fi
  done

echo ""
echo "=== File counts ==="
echo "Backend JS:  $(find "$PROJ/backend/src" -name '*.js' -not -path '*/node_modules/*' 2>/dev/null | wc -l) files"
echo "Frontend JSX: $(find "$PROJ/frontend/src" -name '*.jsx' -not -path '*/node_modules/*' 2>/dev/null | wc -l) files"
echo "Frontend JS:  $(find "$PROJ/frontend/src" -name '*.js' -not -path '*/node_modules/*' 2>/dev/null | wc -l) files"
echo "CSS:          $(find "$PROJ/frontend/src" -name '*.css' -not -path '*/node_modules/*' 2>/dev/null | wc -l) files"
