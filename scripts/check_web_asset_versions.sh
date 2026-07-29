#!/usr/bin/env bash
# Verify that a GitHub Pages deploy cannot mix a new entry module with cached
# old dependency modules. Run this in CI after changing docs/ web assets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRAW="$ROOT/docs/draw.html"
VERSION="$(sed -n 's/.*src="js\/main\.js?v=\([A-Za-z0-9._-]*\)".*/\1/p' "$DRAW")"
CSS_VERSION="$(sed -n 's/.*href="style\.css?v=\([A-Za-z0-9._-]*\)".*/\1/p' "$DRAW")"

if [ -z "$VERSION" ] || [ "$VERSION" != "$CSS_VERSION" ]; then
  echo "draw.html must use the same non-empty version for main.js and style.css" >&2
  exit 1
fi

if rg -n 'from "\./[^"?]+\.js"|new URL\("\./[^"?]+\.js"' "$ROOT/docs/js"; then
  echo "every local ES module and worker must include ?v=$VERSION" >&2
  exit 1
fi

VERSIONS="$(rg --no-filename -o '\?v=[A-Za-z0-9._-]+' "$DRAW" "$ROOT/docs/js" | sed 's/^?v=//' | sort -u)"
if [ "$VERSIONS" != "$VERSION" ]; then
  echo "web asset versions do not match: ${VERSIONS:-missing} (expected $VERSION)" >&2
  exit 1
fi

echo "web asset version: $VERSION"
