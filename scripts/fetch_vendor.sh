#!/bin/zsh
# Download portable Node, ffmpeg, ffprobe, and yt-dlp into a destination folder.
# Cache lives in temp/vendor-cache so rebuilds do not re-download.
# Usage: fetch_vendor.sh DEST [darwin-arm64|darwin-x64|win-x64]...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-}"
if [[ -z "$DEST" ]]; then
  echo "usage: fetch_vendor.sh DEST PLATFORM [PLATFORM...]" >&2
  exit 1
fi
shift
PLATFORMS=("$@")
if [[ ${#PLATFORMS[@]} -eq 0 ]]; then
  echo "usage: fetch_vendor.sh DEST PLATFORM [PLATFORM...]" >&2
  exit 1
fi

NODE_VER="v24.21.0"
FFMPEG_TAG="b6.1.1"
YTDLP_TAG="2026.08.19"
CACHE="$ROOT/temp/vendor-cache"
mkdir -p "$CACHE" "$DEST"

download() {
  local url="$1"
  local out="$2"
  if [[ -f "$out" && -s "$out" ]]; then
    echo "cached $(basename "$out")"
    return 0
  fi
  echo "downloading $(basename "$out")…"
  curl -fL --retry 3 --retry-delay 2 -o "${out}.part" "$url"
  mv "${out}.part" "$out"
}

extract_node_unix() {
  local tarball="$1"
  local bin_out="$2"
  if [[ -x "$bin_out" ]]; then
    return 0
  fi
  local tmp
  tmp="$(mktemp -d "$CACHE/extract.XXXXXX")"
  tar -xzf "$tarball" -C "$tmp"
  local found
  found="$(find "$tmp" -type f -path '*/bin/node' | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "node binary missing in $tarball" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$bin_out")"
  cp "$found" "$bin_out"
  chmod +x "$bin_out"
  rm -rf "$tmp"
}

extract_node_win() {
  local zipfile="$1"
  local bin_out="$2"
  if [[ -f "$bin_out" ]]; then
    return 0
  fi
  local tmp
  tmp="$(mktemp -d "$CACHE/extract.XXXXXX")"
  ditto -x -k "$zipfile" "$tmp"
  local found
  found="$(find "$tmp" -type f -name 'node.exe' | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "node.exe missing in $zipfile" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p "$(dirname "$bin_out")"
  cp "$found" "$bin_out"
  rm -rf "$tmp"
}

copy_exec() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  chmod +x "$dst"
}

sign_mac() {
  local bin="$1"
  codesign --force -s - "$bin" 2>/dev/null || true
  xattr -cr "$bin" 2>/dev/null || true
}

for plat in "${PLATFORMS[@]}"; do
  echo "vendor $plat → $DEST/$plat"
  mkdir -p "$DEST/$plat"
  case "$plat" in
    darwin-arm64)
      download "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz" \
        "$CACHE/node-${NODE_VER}-darwin-arm64.tar.gz"
      extract_node_unix "$CACHE/node-${NODE_VER}-darwin-arm64.tar.gz" "$CACHE/node-darwin-arm64"
      copy_exec "$CACHE/node-darwin-arm64" "$DEST/$plat/node"

      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-darwin-arm64" \
        "$CACHE/ffmpeg-darwin-arm64"
      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffprobe-darwin-arm64" \
        "$CACHE/ffprobe-darwin-arm64"
      copy_exec "$CACHE/ffmpeg-darwin-arm64" "$DEST/$plat/ffmpeg"
      copy_exec "$CACHE/ffprobe-darwin-arm64" "$DEST/$plat/ffprobe"

      download "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/yt-dlp_macos" \
        "$CACHE/yt-dlp_macos"
      copy_exec "$CACHE/yt-dlp_macos" "$DEST/$plat/yt-dlp"

      sign_mac "$DEST/$plat/node"
      sign_mac "$DEST/$plat/ffmpeg"
      sign_mac "$DEST/$plat/ffprobe"
      sign_mac "$DEST/$plat/yt-dlp"
      ;;
    darwin-x64)
      download "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-x64.tar.gz" \
        "$CACHE/node-${NODE_VER}-darwin-x64.tar.gz"
      extract_node_unix "$CACHE/node-${NODE_VER}-darwin-x64.tar.gz" "$CACHE/node-darwin-x64"
      copy_exec "$CACHE/node-darwin-x64" "$DEST/$plat/node"

      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-darwin-x64" \
        "$CACHE/ffmpeg-darwin-x64"
      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffprobe-darwin-x64" \
        "$CACHE/ffprobe-darwin-x64"
      copy_exec "$CACHE/ffmpeg-darwin-x64" "$DEST/$plat/ffmpeg"
      copy_exec "$CACHE/ffprobe-darwin-x64" "$DEST/$plat/ffprobe"

      download "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/yt-dlp_macos" \
        "$CACHE/yt-dlp_macos"
      copy_exec "$CACHE/yt-dlp_macos" "$DEST/$plat/yt-dlp"

      sign_mac "$DEST/$plat/node"
      sign_mac "$DEST/$plat/ffmpeg"
      sign_mac "$DEST/$plat/ffprobe"
      sign_mac "$DEST/$plat/yt-dlp"
      ;;
    win-x64)
      download "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-win-x64.zip" \
        "$CACHE/node-${NODE_VER}-win-x64.zip"
      extract_node_win "$CACHE/node-${NODE_VER}-win-x64.zip" "$CACHE/node-win-x64.exe"
      mkdir -p "$DEST/$plat"
      cp "$CACHE/node-win-x64.exe" "$DEST/$plat/node.exe"

      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-win32-x64" \
        "$CACHE/ffmpeg-win32-x64"
      download "https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffprobe-win32-x64" \
        "$CACHE/ffprobe-win32-x64"
      cp "$CACHE/ffmpeg-win32-x64" "$DEST/$plat/ffmpeg.exe"
      cp "$CACHE/ffprobe-win32-x64" "$DEST/$plat/ffprobe.exe"

      download "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_TAG}/yt-dlp.exe" \
        "$CACHE/yt-dlp.exe"
      cp "$CACHE/yt-dlp.exe" "$DEST/$plat/yt-dlp.exe"
      ;;
    *)
      echo "unknown platform: $plat" >&2
      exit 1
      ;;
  esac
done

cat > "$DEST/THIRD_PARTY.txt" << 'EOF'
Stash ships these tools so you do not have to install anything else.

Node.js
  License: MIT
  https://nodejs.org

ffmpeg / ffprobe
  Builds from https://github.com/eugeneware/ffmpeg-static
  FFmpeg: LGPL/GPL — https://ffmpeg.org
  These static builds typically include GPL components.

yt-dlp
  Source: Unlicense — https://github.com/yt-dlp/yt-dlp
  The macOS and Windows executables are PyInstaller bundles and are GPLv3+.

Express
  License: MIT
  https://expressjs.com
EOF

echo "vendor ready in $DEST"
