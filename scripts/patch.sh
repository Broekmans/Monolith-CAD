#!/bin/sh
# Build a small patch (app code only) for an installed MonoLith folder.
# Usage: sh scripts/patch.sh  ->  release/MonoLith-patch.zip + release/UPDATE-MONOLITH.bat
set -e
cd "$(dirname "$0")/.."
node scripts/build.mjs --min >/dev/null
rm -rf release/win-unpacked
npx electron-builder --win --x64 --dir >/dev/null 2>&1
V=$(node -p "require('./package.json').version")
cd release/win-unpacked
rm -f ../MonoLith-patch.zip
zip -qr -9 ../MonoLith-patch.zip resources/app.asar resources/app.asar.unpacked/kernel resources/app.asar.unpacked/shared
cd ..
sed "s/%V%/$V/g" ../scripts/update-template.bat | sed 's/$/\r/' > UPDATE-MONOLITH.bat
ls -la MonoLith-patch.zip
