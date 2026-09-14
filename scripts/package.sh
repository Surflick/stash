#!/bin/zsh
# Build self-contained Mac + Windows zips. Recipients unzip and double-click.
# Does not leave vendor/ in the working copy — your local Stash stays PATH-based.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d /tmp/stash-package.XXXXXX)"
NAME="Stash"
OUT_DIR="$ROOT/dist"
ZIP_MAC="$OUT_DIR/${NAME}-macOS.zip"
ZIP_WIN="$OUT_DIR/${NAME}-windows.zip"

cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

chmod +x "$ROOT/scripts/fetch_vendor.sh" "$ROOT/scripts/start.sh" "$ROOT/scripts/build_app.sh"

echo "Rebuilding Stash.app…"
"$ROOT/scripts/build_app.sh"

copy_app_files() {
  local dest="$1"
  mkdir -p "$dest/scripts" "$dest/server" "$dest/public" "$dest/assets" "$dest/node_modules"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/scripts/" "$dest/scripts/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/server/" "$dest/server/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/public/" "$dest/public/"
  rsync -a --delete --exclude '.DS_Store' --exclude 'stash-x-card.png' "$ROOT/assets/" "$dest/assets/"
  rsync -a --delete --exclude '.DS_Store' "$ROOT/node_modules/" "$dest/node_modules/"
  cp "$ROOT/package.json" "$dest/package.json"
  cp "$ROOT/package-lock.json" "$dest/package-lock.json"
  cp "$ROOT/README.md" "$dest/README.md"
  cp "$ROOT/LICENSE" "$dest/LICENSE"
  rm -rf "$dest/data" "$dest/temp" "$dest/dist"
  rm -f "$dest/chrome-password-import.csv" "$dest/AGENTS.md"
}

# --- macOS ---
DEST_MAC="$STAGE/mac/$NAME"
mkdir -p "$DEST_MAC"
copy_app_files "$DEST_MAC"
rsync -a --delete --exclude '.DS_Store' "$ROOT/Stash.app" "$DEST_MAC/"
cp "$ROOT/Open Stash.command" "$DEST_MAC/Open Stash.command"
cp "$ROOT/Fix macOS warning.command" "$DEST_MAC/Fix macOS warning.command"
chmod +x \
  "$DEST_MAC/Open Stash.command" \
  "$DEST_MAC/Fix macOS warning.command" \
  "$DEST_MAC/scripts/start.sh" \
  "$DEST_MAC/scripts/fetch_vendor.sh"

echo "Fetching Mac vendor binaries…"
"$ROOT/scripts/fetch_vendor.sh" "$DEST_MAC/vendor" darwin-arm64 darwin-x64
cp "$DEST_MAC/vendor/THIRD_PARTY.txt" "$DEST_MAC/THIRD_PARTY.txt"
xattr -cr "$DEST_MAC" 2>/dev/null || true

mkdir -p "$OUT_DIR"
rm -f "$ZIP_MAC"
ditto -c -k --sequesterRsrc --keepParent "$DEST_MAC" "$ZIP_MAC"
xattr -cr "$ZIP_MAC" 2>/dev/null || true

# --- Windows ---
DEST_WIN="$STAGE/win/$NAME"
mkdir -p "$DEST_WIN"
copy_app_files "$DEST_WIN"
cp "$ROOT/Open Stash.bat" "$DEST_WIN/Open Stash.bat"
rm -rf "$DEST_WIN/Stash.app"
rm -f "$DEST_WIN/Open Stash.command" "$DEST_WIN/Fix macOS warning.command"
rm -f "$DEST_WIN/scripts/stash_launcher.c" "$DEST_WIN/scripts/build_app.sh"

echo "Fetching Windows vendor binaries…"
"$ROOT/scripts/fetch_vendor.sh" "$DEST_WIN/vendor" win-x64
cp "$DEST_WIN/vendor/THIRD_PARTY.txt" "$DEST_WIN/THIRD_PARTY.txt"

rm -f "$ZIP_WIN"
ditto -c -k --keepParent "$DEST_WIN" "$ZIP_WIN"
xattr -cr "$ZIP_WIN" 2>/dev/null || true

MAC_BYTES=$(stat -f%z "$ZIP_MAC")
WIN_BYTES=$(stat -f%z "$ZIP_WIN")
echo "Packed $ZIP_MAC ($MAC_BYTES bytes)"
echo "Packed $ZIP_WIN ($WIN_BYTES bytes)"
