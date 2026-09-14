#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/Tube Stash.app"
RES="$APP/Contents/Resources"
MACOS="$APP/Contents/MacOS"
ICON_SRC="$ROOT/assets/app-icon-1024.png"
LAUNCHER_BODY='#!/bin/zsh
cd "$(dirname "$0")"
export STASH_ROOT="$PWD"
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec "$STASH_ROOT/scripts/start.sh"
'

echo "Building → $APP"
mkdir -p "$MACOS" "$RES"

# Rosetta shells report x86_64 on Apple Silicon. Compile a native arm64
# binary so Finder / Launch Services can actually spawn the app.
SRC="$ROOT/scripts/stash_launcher.c"
OUT="$MACOS/Stash.new"
CLANG_ARCHS=(-arch "$(uname -m)")
if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" == "1" ]]; then
  CLANG_ARCHS=(-arch arm64)
fi
clang "${CLANG_ARCHS[@]}" -o "$OUT" "$SRC"
chmod +x "$OUT"
rm -rf "$APP/Contents/MacOS/Stash"
mv "$OUT" "$MACOS/Stash"

cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Tube Stash</string>
  <key>CFBundleExecutable</key>
  <string>Stash</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.grokdesktop.stash</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Tube Stash</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.3.3</string>
  <key>CFBundleVersion</key>
  <string>1.3.3</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSUIElement</key>
  <false/>
  <key>NSHumanReadableCopyright</key>
  <string>Local YouTube downloader for this Mac.</string>
</dict>
</plist>
PLIST

echo -n "APPL????" > "$APP/Contents/PkgInfo"

ICONSET="$ROOT/temp/AppIcon.iconset"
mkdir -p "$ROOT/temp"
if [[ -f "$ICON_SRC" ]]; then
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  BASE="$ROOT/temp/icon-1024.png"
  sips -s format png -z 1024 1024 "$ICON_SRC" --out "$BASE" >/dev/null
  for size in 16 32 128 256 512; do
    sips -z $size $size "$BASE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z $((size*2)) $((size*2)) "$BASE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"
  echo "Icon installed."
fi

# Board launcher: run start.sh relative to this folder so the zip works
# on someone else's Mac. Keep the old filename so existing shortcuts still open.
print -r -- "$LAUNCHER_BODY" > "$ROOT/Open Tube Stash.command"
print -r -- "$LAUNCHER_BODY" > "$ROOT/Open Stash.command"
chmod +x "$ROOT/Open Tube Stash.command" "$ROOT/Open Stash.command" "$ROOT/scripts/start.sh" "$ROOT/scripts/package.sh" 2>/dev/null || \
  chmod +x "$ROOT/Open Tube Stash.command" "$ROOT/Open Stash.command" "$ROOT/scripts/start.sh"

codesign --force --deep -s - "$APP" 2>/dev/null || true
xattr -cr "$APP" "$ROOT/Open Tube Stash.command" "$ROOT/Open Stash.command" "$ROOT/scripts/start.sh" 2>/dev/null || true
touch "$APP"

# Drop the old bundle so Finder / the board don't show two apps.
if [[ -d "$ROOT/Stash.app" ]]; then
  rm -rf "$ROOT/Stash.app"
fi

echo "Done."
echo "App: $APP"
echo "Launcher: $ROOT/Open Tube Stash.command"
