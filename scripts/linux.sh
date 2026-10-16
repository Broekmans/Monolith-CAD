#!/bin/sh
# Linux build (secondary platform): release/MonoLith-<ver>-linux-x64.AppImage + .tar.gz
# Needs LibreDWG's dwg2dxf + dxf2dwg (static Linux build) in vendor/libredwg-linux/ — the GitHub workflow
# .github/workflows/linux-release.yml builds them; locally: LIBREDWG_BIN=<prefix>/bin sh scripts/linux.sh
set -e
cd "$(dirname "$0")/.."
if [ -n "$LIBREDWG_BIN" ]; then
  mkdir -p vendor/libredwg-linux
  cp "$LIBREDWG_BIN/dwg2dxf" "$LIBREDWG_BIN/dxf2dwg" vendor/libredwg-linux/
  cp vendor/libredwg/COPYING.txt vendor/libredwg-linux/
  strip vendor/libredwg-linux/dwg2dxf vendor/libredwg-linux/dxf2dwg 2>/dev/null || true
fi
[ -x vendor/libredwg-linux/dwg2dxf ] || echo "warning: no vendor/libredwg-linux/dwg2dxf — DWG import will need ODA"
node scripts/build.mjs --min >/dev/null
rm -rf release/linux-unpacked
npx electron-builder --linux --x64 --publish never
ls -la release/*.AppImage release/*.tar.gz
