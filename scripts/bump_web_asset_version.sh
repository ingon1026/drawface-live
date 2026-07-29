#!/usr/bin/env bash
# Update the single cache-busting version used by draw.html and its local ES
# module graph. Example: scripts/bump_web_asset_version.sh 20260730.1
set -euo pipefail

VERSION="${1:?usage: scripts/bump_web_asset_version.sh <version>}"
case "$VERSION" in
  *[!A-Za-z0-9._-]*|'') echo "version may contain only letters, digits, . _ and -" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
find "$ROOT/docs/js" -type f -name '*.js' -exec sed -E -i "s/\?v=[A-Za-z0-9._-]+/?v=$VERSION/g" {} +
sed -E -i "s/(style\.css|js\/main\.js)\?v=[A-Za-z0-9._-]+/\1?v=$VERSION/g" "$ROOT/docs/draw.html"
"$ROOT/scripts/check_web_asset_versions.sh"
