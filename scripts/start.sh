#!/bin/bash
# Start Stash's local server and open the UI.
# The node process is double-forked into its own session so a Finder-launched
# .app can exit without macOS killing the server.
set -euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/3.13/bin:${HOME}/Library/Python/3.13/bin:/usr/bin:/bin:${PATH}"

ROOT="${STASH_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${PORT:-47841}"
URL="http://127.0.0.1:${PORT}"
LOGDIR="${HOME}/Library/Logs/Stash"
mkdir -p "$LOGDIR"
LOG="${LOGDIR}/server.log"
LAUNCH_LOG="${LOGDIR}/launcher.log"

# Giveaway zip ships Node / ffmpeg / yt-dlp in vendor/. Your own copy
# without that folder keeps using Homebrew / PATH, unchanged.
case "$(uname -m)" in
  arm64) VENDOR="${ROOT}/vendor/darwin-arm64" ;;
  x86_64) VENDOR="${ROOT}/vendor/darwin-x64" ;;
  *) VENDOR="" ;;
esac
if [ -n "$VENDOR" ] && [ -x "${VENDOR}/node" ]; then
  xattr -cr "$VENDOR" 2>/dev/null || true
  export PATH="${VENDOR}:${PATH}"
  if [ -x "${VENDOR}/yt-dlp" ]; then
    export YTDLP="${YTDLP:-${VENDOR}/yt-dlp}"
  fi
fi

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LAUNCH_LOG"
}

alert() {
  /usr/bin/osascript -e "display alert \"Stash\" message \"${1}\" as critical" >/dev/null 2>&1 || true
}

notify() {
  /usr/bin/osascript -e "display notification \"${1}\" with title \"Stash\"" >/dev/null 2>&1 || true
}

health() {
  /usr/bin/curl -sf --max-time 1 "${URL}/api/health" >/dev/null 2>&1
}

open_ui() {
  /usr/bin/open "${URL}" || true
}

log "start ROOT=${ROOT}"
notify "Opening Stash…"

if [ ! -f "${ROOT}/server/index.js" ]; then
  log "missing server/index.js"
  alert "Project files missing at:\n${ROOT}"
  exit 1
fi
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  log "node not found PATH=${PATH}"
  alert "Node.js is required. Install from nodejs.org, or run:\n\nbrew install node"
  exit 1
fi
NODE="$(command -v node)"
log "node ${NODE} $($NODE -v 2>/dev/null || true)"

if [ ! -d "${ROOT}/node_modules/express" ]; then
  notify "Installing Stash…"
  log "npm install"
  npm install --no-fund --no-audit >>"$LAUNCH_LOG" 2>&1
fi

have_ytdlp() {
  command -v yt-dlp >/dev/null 2>&1 && return 0
  python3 -c "import yt_dlp" >/dev/null 2>&1 && return 0
  return 1
}

have_ffmpeg() {
  command -v ffmpeg >/dev/null 2>&1
}

install_tools() {
  if command -v brew >/dev/null 2>&1; then
    notify "Installing ffmpeg + yt-dlp…"
    log "brew install ffmpeg yt-dlp"
    brew install ffmpeg yt-dlp >>"$LAUNCH_LOG" 2>&1 || true
  fi
  if ! have_ytdlp; then
    log "pip3 install yt-dlp"
    python3 -m pip install -U yt-dlp >>"$LAUNCH_LOG" 2>&1 || true
  fi
}

if ! have_ffmpeg || ! have_ytdlp; then
  log "missing tools ffmpeg=$(have_ffmpeg && echo yes || echo no) ytdlp=$(have_ytdlp && echo yes || echo no)"
  CHOICE="$(
    /usr/bin/osascript <<'APPLESCRIPT'
try
  set theBtn to button returned of (display dialog "Stash needs ffmpeg and yt-dlp once, then it can save videos to Downloads.

Install them now? (Homebrew if you have it, otherwise pip.)" buttons {"Not now", "Install"} default button "Install" with title "Stash")
  return theBtn
on error
  return "Not now"
end try
APPLESCRIPT
  )"
  if [ "$CHOICE" = "Install" ]; then
    install_tools
  fi
fi

if ! have_ffmpeg || ! have_ytdlp; then
  log "tools still missing"
  alert "Stash needs ffmpeg and yt-dlp.\\n\\nIn Terminal:\\n\\nbrew install ffmpeg yt-dlp\\n\\nor:\\n\\npython3 -m pip install -U yt-dlp\\nbrew install ffmpeg"
fi

if health; then
  log "already up"
  open_ui
  notify "Ready — paste a YouTube link"
  exit 0
fi

mkdir -p "${HOME}/Downloads"

PY=""
for candidate in /usr/bin/python3 /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 python3; do
  if [ -x "$candidate" ] || command -v "$candidate" >/dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  log "python3 missing — falling back to nohup"
  nohup "$NODE" "${ROOT}/server/index.js" >>"$LOG" 2>&1 </dev/null &
  echo $! >"${LOGDIR}/server.pid"
else
  log "daemonize via ${PY}"
  "$PY" - "$NODE" "${ROOT}/server/index.js" "$LOG" "${LOGDIR}/server.pid" <<'PY'
import os, sys
node, script, logfile, pidfile = sys.argv[1:5]
if os.fork() > 0:
    os._exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
os.chdir("/")
os.umask(0)
try:
    with open(pidfile, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))
except OSError:
    pass
fd = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
os.close(fd)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.close(devnull)
os.environ["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")
os.execv(node, [node, script])
PY
fi

for _ in $(seq 1 80); do
  if health; then
    log "up"
    open_ui
    notify "Ready — paste a YouTube link"
    exit 0
  fi
  sleep 0.25
done

log "timeout — see ${LOG}"
alert "Stash did not start.\n\nSee log:\n${LOG}"
exit 1
