'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const YTDLP_MISSING = 'yt-dlp is not installed. Tube Stash will try python3 -m yt_dlp.';
const PROBE_TIMEOUT_MS = 45_000;
const VERSION_TIMEOUT_MS = 8_000;
const MAX_PROBE_STDOUT = 20 * 1024 * 1024;
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const VALID_FORMAT_IDS = new Set(['best', '2160', '1440', '1080', '720', '480', '360', 'audio-m4a', 'audio-mp3']);
const HEIGHT_LABELS = {
  2160: '2160p · 4K',
  1440: '1440p · 2K',
  1080: '1080p · Full HD',
  720: '720p · HD',
  480: '480p',
  360: '360p',
};
const YT_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
]);
const FRAMEWORK_PYTHON = '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3';
const HOMEBREW_FFMPEG = '/opt/homebrew/bin/ffmpeg';

const activeChildren = new Set();
let toolsCache = null;
let toolsCacheAt = 0;
const TOOLS_TTL_MS = 10_000;

function log(...args) {
  console.log('[stash]', ...args);
}

class YtError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'YtError';
    this.status = status;
  }
}

function vendorDir() {
  const root = process.env.STASH_ROOT || path.join(__dirname, '..');
  let key = null;
  if (process.platform === 'darwin') {
    key = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (process.platform === 'win32') {
    key = 'win-x64';
  }
  if (!key) return null;
  const dir = path.join(root, 'vendor', key);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function vendorFile(name) {
  const dir = vendorDir();
  if (!dir || !name) return null;
  const names = [name];
  if (process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name)) {
    names.push(`${name}.exe`);
  }
  for (const n of names) {
    const candidate = path.join(dir, n);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function whichSync(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return fs.existsSync(name) ? name : null;
    }
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const names = [name];
    if (process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name)) {
      names.push(`${name}.exe`);
    }
    for (const n of names) {
      const candidate = path.join(dir, n);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        if (process.platform === 'win32' && fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function descendantPids(pid) {
  const result = [];
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let out = '';
    try {
      out = execFileSync('pgrep', ['-P', String(current)], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue;
    }
    for (const token of out.split(/\s+/)) {
      const n = Number(token);
      if (Number.isInteger(n) && n > 0) {
        result.push(n);
        stack.push(n);
      }
    }
  }
  return result;
}

function killChild(child, signal = 'SIGTERM') {
  if (!child) return;
  const pid = child.pid;
  if (pid) {
    for (const cpid of descendantPids(pid)) {
      try {
        process.kill(cpid, signal);
      } catch {
        // already gone
      }
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
  if (pid) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

function trackChild(child) {
  activeChildren.add(child);
  const untrack = () => activeChildren.delete(child);
  child.once('close', untrack);
  child.once('error', untrack);
  return child;
}

function killAllChildren() {
  for (const child of [...activeChildren]) {
    killChild(child, 'SIGTERM');
  }
  setTimeout(() => {
    for (const child of [...activeChildren]) {
      killChild(child, 'SIGKILL');
    }
  }, 1500).unref?.();
}

function spawnCmd(cmdArr, args, options = {}) {
  const env = {
    ...process.env,
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    ...(options.env || {}),
  };
  delete env.FORCE_COLOR;
  const child = spawn(cmdArr[0], [...cmdArr.slice(1), ...args], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: options.cwd || undefined,
  });
  return trackChild(child);
}

function runCaptured(cmdArr, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCmd(cmdArr, args);
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message, error: err, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, 'SIGTERM');
      setTimeout(() => killChild(child, 'SIGKILL'), 1000).unref?.();
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_PROBE_STDOUT) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: -1, stdout, stderr: stderr || error.message, error, timedOut });
    });
    child.on('close', (code, signal) => {
      finish({
        code: code == null ? -1 : code,
        signal,
        stdout,
        stderr,
        error: null,
        timedOut,
      });
    });
  });
}

async function tryBinVersion(cmdArr, extraArgs, parse) {
  const result = await runCaptured(cmdArr, extraArgs, VERSION_TIMEOUT_MS);
  if (result.timedOut || result.code !== 0) return null;
  const version = parse(result.stdout || '');
  return version || null;
}

function parseYtdlpVersion(stdout) {
  const line = String(stdout).trim().split(/\r?\n/)[0] || '';
  const token = line.trim().split(/\s+/)[0];
  return token || null;
}

function parseFfmpegVersion(stdout) {
  const m = String(stdout).match(/ffmpeg version (\S+)/i);
  if (!m) return null;
  return m[1].replace(/[,].*$/, '');
}

async function resolveYtdlp() {
  const home = os.homedir();
  const candidates = [];
  if (process.env.YTDLP) candidates.push([process.env.YTDLP]);
  const bundledYtdlp = vendorFile('yt-dlp');
  if (bundledYtdlp) candidates.push([bundledYtdlp]);
  candidates.push([path.join(home, 'Library', 'Python', '3.13', 'bin', 'yt-dlp')]);
  const pathYtdlp = whichSync('yt-dlp');
  if (pathYtdlp) candidates.push([pathYtdlp]);
  else candidates.push(['yt-dlp']);
  const frameworkPy = whichSync(FRAMEWORK_PYTHON) || (fs.existsSync(FRAMEWORK_PYTHON) ? FRAMEWORK_PYTHON : null);
  if (frameworkPy) candidates.push([frameworkPy, '-m', 'yt_dlp']);
  const pathPy = whichSync('python3');
  if (pathPy && pathPy !== frameworkPy) candidates.push([pathPy, '-m', 'yt_dlp']);
  candidates.push(['python3', '-m', 'yt_dlp']);

  const seen = new Set();
  for (const cmd of candidates) {
    const key = cmd.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    if (path.isAbsolute(cmd[0]) && !fs.existsSync(cmd[0])) continue;
    const version = await tryBinVersion(cmd, ['--version'], parseYtdlpVersion);
    if (version) {
      return { ok: true, version, cmd };
    }
  }
  return { ok: false, version: null, cmd: [pathPy || 'python3', '-m', 'yt_dlp'] };
}

async function resolveFfmpeg() {
  const candidates = [
    vendorFile('ffmpeg'),
    HOMEBREW_FFMPEG,
    whichSync('ffmpeg'),
    '/usr/local/bin/ffmpeg',
    '/opt/local/bin/ffmpeg',
  ].filter(Boolean);
  const seen = new Set();
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (path.isAbsolute(p) && !fs.existsSync(p)) continue;
    const version = await tryBinVersion([p], ['-version'], parseFfmpegVersion);
    if (version) return { ok: true, version, path: p };
  }
  return { ok: false, version: null, path: null };
}

async function resolveTools(force = false) {
  if (!force && toolsCache && Date.now() - toolsCacheAt < TOOLS_TTL_MS) return toolsCache;
  const [ytdlp, ffmpeg] = await Promise.all([resolveYtdlp(), resolveFfmpeg()]);
  toolsCache = { ytdlp, ffmpeg };
  toolsCacheAt = Date.now();
  return toolsCache;
}

function getTools(force) {
  return resolveTools(force);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isYouTubeUrl(url) {
  const host = hostOf(url);
  return YT_HOSTS.has(host) || host.endsWith('.youtube.com');
}

function isPlaylistUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const pathname = parsed.pathname.toLowerCase();
  if (pathname.includes('/playlist')) return true;
  const list = parsed.searchParams.get('list');
  if (!list) return false;
  const hasVideo =
    parsed.searchParams.has('v') ||
    /\/(watch|shorts|embed|live)\b/i.test(pathname) ||
    hostOf(url) === 'youtu.be';
  return !hasVideo;
}

function normalizeUrlInput(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return '';
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = `https://${s}`;
  return s;
}

function validateUrl(raw) {
  const s = normalizeUrlInput(raw);
  if (!s) throw new YtError('Paste a video URL first.', 400);
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new YtError('That does not look like a valid URL.', 400);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'javascript:' || protocol === 'file:' || protocol === 'data:' || protocol === 'vbscript:') {
    throw new YtError('That URL scheme is not allowed.', 400);
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new YtError('Only http(s) URLs are supported.', 400);
  }
  if (!parsed.hostname) throw new YtError('That does not look like a valid URL.', 400);
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    throw new YtError('That does not look like a valid URL.', 400);
  }
  return parsed.href;
}

function formatDuration(seconds) {
  if (seconds == null || seconds === '') return null;
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return null;
  const s = Math.round(n);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function formatUploadDate(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function truncate(text, max) {
  if (text == null) return null;
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

function isVideoFormat(f) {
  if (!f || typeof f !== 'object') return false;
  if (!f.vcodec || f.vcodec === 'none') return false;
  if (f.ext === 'mhtml' || f.format_note === 'storyboard' || f.protocol === 'mhtml') return false;
  if (typeof f.height !== 'number' || f.height <= 0) return false;
  return true;
}

function pickThumbnail(info) {
  if (!info || typeof info !== 'object') return null;
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  let best = null;
  let bestScore = -1;
  for (const t of thumbs) {
    if (!t || !t.url) continue;
    const w = Number(t.width) || 0;
    const h = Number(t.height) || 0;
    const pref = Number(t.preference) || 0;
    const score = w * h || pref * 1000;
    if (score >= bestScore) {
      best = t.url;
      bestScore = score;
    }
  }
  return best || info.thumbnail || null;
}

function youtubeThumb(id) {
  if (!id) return null;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function buildFormats(ytFormats, { allStandards = false } = {}) {
  const formats = [{ id: 'best', label: 'Best available', kind: 'video', ext: 'mp4' }];
  const heights = new Set();
  for (const f of ytFormats || []) {
    if (isVideoFormat(f)) heights.add(f.height);
  }
  const maxH = heights.size ? Math.max(...heights) : 0;
  const nearestAbove = maxH > 0 ? [...STANDARD_HEIGHTS].reverse().find((x) => x >= maxH) : null;

  for (const h of STANDARD_HEIGHTS) {
    const include = allStandards || (maxH > 0 && (h <= maxH || h === nearestAbove));
    if (!include) continue;
    formats.push({
      id: String(h),
      label: HEIGHT_LABELS[h] || `${h}p`,
      kind: 'video',
      ext: 'mp4',
    });
  }

  formats.push(
    { id: 'audio-m4a', label: 'Audio · M4A', kind: 'audio', ext: 'm4a' },
    { id: 'audio-mp3', label: 'Audio · MP3', kind: 'audio', ext: 'mp3' }
  );
  return formats;
}

function formatLabel(formatId) {
  if (formatId === 'best') return 'Best available';
  if (formatId === 'audio-m4a') return 'Audio · M4A';
  if (formatId === 'audio-mp3') return 'Audio · MP3';
  const n = Number(formatId);
  if (HEIGHT_LABELS[n]) return HEIGHT_LABELS[n];
  if (Number.isFinite(n)) return `${n}p`;
  return String(formatId || 'Best available');
}

function formatKind(formatId) {
  return String(formatId || '').startsWith('audio-') ? 'audio' : 'video';
}

function formatArgs(formatId) {
  const id = VALID_FORMAT_IDS.has(formatId) ? formatId : 'best';
  if (id === 'audio-m4a') {
    return ['-x', '--audio-format', 'm4a', '--audio-quality', '0', '-f', 'ba/b'];
  }
  if (id === 'audio-mp3') {
    return ['-x', '--audio-format', 'mp3', '--audio-quality', '192K', '-f', 'ba/b'];
  }
  // Prefer H.264 + AAC MP4 so QuickTime / Finder actually show the picture.
  // Never fall back to audio-only `b` — that is how "video" jobs become m4a/mp3.
  const args = [
    '--merge-output-format',
    'mp4',
    '--remux-video',
    'mp4',
    '-S',
    'res,vcodec:h264,acodec:m4a',
  ];
  if (id === 'best') {
    args.push(
      '-f',
      'bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[vcodec^=avc1]+ba/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/best[vcodec!=none]'
    );
  } else {
    args.push(
      '-f',
      `bv*[height<=${id}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${id}][vcodec^=avc1]+ba/bv*[height<=${id}]+ba/best[height<=${id}][vcodec!=none]/bv*+ba/best[vcodec!=none]`
    );
  }
  return args;
}

function extractJson(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

function lastMeaningfulError(stderr, fallback = 'Download failed') {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const err = line.match(/^ERROR:\s*(.*)$/i);
    if (err) {
      const msg = err[1].slice(0, 400);
      if (/Failed to resolve|nodename nor servname|getaddrinfo/i.test(msg)) {
        return 'Could not reach that URL.';
      }
      if (/private video|login required|sign in/i.test(msg)) {
        return 'This video is private or requires sign-in.';
      }
      if (/video unavailable|has been removed/i.test(msg)) {
        return 'This video is unavailable.';
      }
      if (/403|Forbidden|unable to download video data/i.test(msg)) {
        return 'YouTube blocked this stream. Retry — Tube Stash will try a different method.';
      }
      return msg.replace(/\s*\(caused by[\s\S]*$/, '').trim();
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^(WARNING:|\[debug\]|\[info\]|\[youtube\]|\[download\])/i.test(line)) continue;
    if (line.length > 8 && line.length < 400) return line;
  }
  return fallback;
}

function is403Error(text) {
  return /403|Forbidden|unable to download video data|blocked this stream/i.test(String(text || ''));
}

function approxDownloaded(percent, totalStr) {
  if (!totalStr || !Number.isFinite(percent)) return null;
  const m = String(totalStr).match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return null;
  const n = (parseFloat(m[1]) * percent) / 100;
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(2)}${m[2]}`;
}

function parseProgressLine(line) {
  const dest = line.match(/^\[download\]\s+Destination:\s+(.+)$/i);
  if (dest) return { type: 'destination', path: dest[1].trim() };

  const already = line.match(/^\[download\]\s+(.+?)\s+has already been downloaded/i);
  if (already) return { type: 'destination', path: already[1].trim() };

  const merge = line.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"/i);
  if (merge) return { type: 'merge', path: merge[1].trim() };

  const extract = line.match(/^\[ExtractAudio\]\s+Destination:\s+(.+)$/i);
  if (extract) return { type: 'extract', path: extract[1].trim() };

  const ffmpegDest = line.match(/^\[ffmpeg\]\s+Destination:\s+(.+)$/i);
  if (ffmpegDest) return { type: 'extract', path: ffmpegDest[1].trim() };

  const move = line.match(/^\[MoveFiles\]\s+.*(?:to|:)\s+"?(.+?)"?\s*$/i);
  if (move) return { type: 'destination', path: move[1].replace(/^"|"$/g, '').trim() };

  if (/^\[(Merger|ExtractAudio|ffmpeg)\]/i.test(line)) return { type: 'status', status: 'merging' };

  const prog = line.match(
    /^\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+~?\s*(\S+)(?:\s+in\s+(\S+))?(?:\s+at\s+(\S+))?(?:\s+ETA\s+(\S+))?/i
  );
  if (prog) {
    const percent = Math.min(100, Math.max(0, parseFloat(prog[1])));
    const total = !prog[2] || /^unknown/i.test(prog[2]) ? null : prog[2];
    const speed = !prog[4] || /^unknown/i.test(prog[4]) ? null : prog[4];
    const eta = !prog[5] || /^unknown/i.test(prog[5]) ? null : prog[5].replace(/[).].*$/, '');
    return {
      type: 'progress',
      percent,
      total,
      speed,
      eta,
      downloaded: approxDownloaded(percent, total),
    };
  }

  const simple = line.match(/^\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (simple) {
    const percent = Math.min(100, Math.max(0, parseFloat(simple[1])));
    return { type: 'progress', percent, total: null, speed: null, eta: null, downloaded: null };
  }

  return null;
}

function commonFields(info, fallbackUrl) {
  const id = info.id || info.display_id || null;
  const channel = info.channel || info.uploader || info.uploader_id || null;
  const duration = Number.isFinite(Number(info.duration)) ? Number(info.duration) : null;
  let thumbnail = pickThumbnail(info);
  if (!thumbnail && id && isYouTubeUrl(fallbackUrl || info.webpage_url || '')) thumbnail = youtubeThumb(id);
  return {
    id,
    title: info.title || info.fulltitle || info.playlist_title || 'Untitled',
    channel,
    channelUrl: info.channel_url || info.uploader_url || null,
    duration,
    durationText: formatDuration(duration),
    thumbnail,
    viewCount: Number.isFinite(Number(info.view_count)) ? Number(info.view_count) : null,
    uploadDate: formatUploadDate(info.upload_date || info.release_date),
    webpageUrl: info.webpage_url || info.original_url || fallbackUrl,
    isLive: !!(info.is_live || info.live_status === 'is_live'),
    description: truncate(info.description, 400),
  };
}

function mapPlaylistEntry(entry, fallbackHostUrl) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry._type === 'playlist') return null;
  const id = entry.id || entry.url || null;
  const url =
    entry.webpage_url ||
    entry.url ||
    (id && !String(id).includes('://') && isYouTubeUrl(fallbackHostUrl)
      ? `https://www.youtube.com/watch?v=${id}`
      : id && String(id).includes('://')
        ? id
        : null);
  const duration = Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null;
  return {
    id,
    title: entry.title || entry.id || 'Untitled',
    url,
    thumbnail: pickThumbnail(entry) || (id && isYouTubeUrl(url || fallbackHostUrl) ? youtubeThumb(id) : null),
    duration,
    channel: entry.channel || entry.uploader || entry.uploader_id || null,
  };
}

function ffmpegArgs(tools) {
  if (tools.ffmpeg && tools.ffmpeg.ok && tools.ffmpeg.path) {
    return ['--ffmpeg-location', tools.ffmpeg.path];
  }
  return [];
}

function baseYtdlpArgs(tools) {
  return ['--no-warnings', '--color', 'never', ...ffmpegArgs(tools)];
}

async function probe(rawUrl) {
  const url = validateUrl(rawUrl);
  const tools = await resolveTools();
  if (!tools.ytdlp.ok) throw new YtError(YTDLP_MISSING, 502);

  const playlist = isPlaylistUrl(url);
  const args = [
    ...baseYtdlpArgs(tools),
    '--dump-single-json',
    '--skip-download',
    '--socket-timeout',
    '20',
    '--no-progress',
  ];
  if (playlist) args.push('--flat-playlist');
  else args.push('--no-playlist');
  args.push('--', url);

  log('probe', playlist ? 'playlist' : 'video', url);
  const result = await runCaptured(tools.ytdlp.cmd, args, PROBE_TIMEOUT_MS);

  if (result.timedOut) throw new YtError('Timed out while fetching video info.', 502);

  if (result.code !== 0) {
    const msg = lastMeaningfulError(result.stderr || result.stdout, 'Could not fetch video info.');
    const lower = msg.toLowerCase();
    const status = /unsupported url|invalid url|is not a valid url/.test(lower) ? 400 : 502;
    throw new YtError(msg, status);
  }

  const info = extractJson(result.stdout);
  if (!info) throw new YtError('Could not read video info from yt-dlp.', 502);

  const type = info._type || (Array.isArray(info.entries) ? 'playlist' : 'video');
  if (type === 'playlist' || playlist) {
    const entries = [];
    for (const entry of info.entries || []) {
      const mapped = mapPlaylistEntry(entry, url);
      if (mapped) entries.push(mapped);
      if (entries.length >= 50) break;
    }
    const fields = commonFields(info, url);
    if (!fields.title || fields.title === 'Untitled') {
      fields.title = info.playlist_title || info.title || 'Playlist';
    }
    return {
      ok: true,
      kind: 'playlist',
      source: isYouTubeUrl(url) ? 'youtube' : 'generic',
      ...fields,
      playlistCount: Number(info.playlist_count || info.n_entries || entries.length) || entries.length,
      entries,
      formats: buildFormats(null, { allStandards: true }),
    };
  }

  return {
    ok: true,
    kind: 'video',
    source: isYouTubeUrl(url) ? 'youtube' : 'generic',
    ...commonFields(info, url),
    formats: buildFormats(info.formats || info.requested_formats || []),
  };
}

async function startDownload({ url, formatId, playlist, outputDir, onProgress, onStatus, onLine, extraArgs }) {
  const tools = await resolveTools();
  if (!tools.ytdlp.ok) throw new YtError(YTDLP_MISSING, 502);
  fs.mkdirSync(outputDir, { recursive: true });
  const template = path.join(outputDir, '%(title).180B [%(id)s].%(ext)s');
  const args = [
    ...baseYtdlpArgs(tools),
    '--newline',
    '--progress',
    '--retries',
    '5',
    '--fragment-retries',
    '5',
    '--no-overwrites',
    '--windows-filenames',
    playlist ? '--yes-playlist' : '--no-playlist',
    ...formatArgs(formatId),
    ...(Array.isArray(extraArgs) ? extraArgs : []),
    '-o',
    template,
    '--',
    url,
  ];

  log('download', formatId, playlist ? 'playlist' : 'single', url);
  const child = spawnCmd(tools.ytdlp.cmd, args, { cwd: outputDir });
  const destinations = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  let logBuf = '';

  const handleLine = (line) => {
    if (!line) return;
    if (typeof onLine === 'function') onLine(line);
    const parsed = parseProgressLine(line);
    if (!parsed) return;
    if (parsed.path) {
      destinations.push(parsed.path);
      if (parsed.type === 'merge' || parsed.type === 'extract') {
        if (typeof onStatus === 'function') onStatus('merging');
      }
    } else if (parsed.type === 'status' && typeof onStatus === 'function') {
      onStatus(parsed.status);
    } else if (parsed.type === 'progress' && typeof onProgress === 'function') {
      onProgress(parsed);
    }
  };

  const feed = (chunk, which) => {
    logBuf += chunk;
    if (logBuf.length > 96 * 1024) logBuf = logBuf.slice(-64 * 1024);
    if (which === 'stderr') {
      stderrBuf += chunk;
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-48 * 1024);
    } else {
      stdoutBuf += chunk;
    }
    let buf = which === 'stderr' ? stderrBuf : stdoutBuf;
    buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = buf.split('\n');
    const rest = lines.pop();
    if (which === 'stderr') stderrBuf = rest;
    else stdoutBuf = rest;
    for (const line of lines) handleLine(line.trimEnd());
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => feed(c, 'stdout'));
  child.stderr.on('data', (c) => feed(c, 'stderr'));

  return {
    child,
    getDestinations: () => destinations.slice(),
    getStderr: () => stderrBuf,
    getLog: () => logBuf,
    flush: () => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trimEnd());
      stdoutBuf = '';
      if (stderrBuf.trim()) {
        const leftover = stderrBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        stderrBuf = '';
        for (const line of leftover) handleLine(line.trimEnd());
      }
    },
  };
}

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];
const AUDIO_EXTS = ['.m4a', '.mp3', '.opus', '.ogg', '.wav', '.aac'];

function pickOutputFile(paths, outputDir, { kind } = {}) {
  const preferred =
    kind === 'audio'
      ? [...AUDIO_EXTS, ...VIDEO_EXTS]
      : [...VIDEO_EXTS, ...AUDIO_EXTS];
  const resolved = [];
  for (const p of paths || []) {
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(outputDir || process.cwd(), p);
    resolved.push(abs);
  }
  const existing = resolved.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  const pool = existing.length ? existing : resolved;
  if (kind === 'video') {
    const videoOnly = pool.filter((p) => VIDEO_EXTS.some((ext) => p.toLowerCase().endsWith(ext)));
    if (videoOnly.length) {
      for (const ext of VIDEO_EXTS) {
        for (let i = videoOnly.length - 1; i >= 0; i--) {
          if (videoOnly[i].toLowerCase().endsWith(ext)) return videoOnly[i];
        }
      }
      return videoOnly[videoOnly.length - 1];
    }
  }
  for (const ext of preferred) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (pool[i].toLowerCase().endsWith(ext)) return pool[i];
    }
  }
  return pool[pool.length - 1] || null;
}

function ffprobeBin(tools) {
  const bundled = vendorFile('ffprobe');
  if (bundled) return bundled;
  const ffmpeg = tools && tools.ffmpeg && tools.ffmpeg.path;
  if (ffmpeg) {
    const dir = path.dirname(ffmpeg);
    for (const name of ['ffprobe', 'ffprobe.exe']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return whichSync('ffprobe');
}

function isPlayableMacVideoCodec(name) {
  return /^(h264|avc1|avc3|hevc|h265|hev1|hvc1)$/i.test(String(name || ''));
}

async function inspectMedia(filePath, tools) {
  const probe = ffprobeBin(tools);
  if (!probe) return { streams: [] };
  const result = await runCaptured(
    [probe],
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', filePath],
    15_000
  );
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return { streams: Array.isArray(parsed.streams) ? parsed.streams : [] };
  } catch {
    return { streams: [] };
  }
}

function videoStreamOf(info) {
  return (info.streams || []).find((s) => {
    if (!s || s.codec_type !== 'video') return false;
    const name = String(s.codec_name || '').toLowerCase();
    if (name === 'mjpeg' || name === 'png' || name === 'webp') return false;
    return true;
  });
}

async function ensurePlayableVideo(filePath) {
  const tools = await resolveTools();
  const info = await inspectMedia(filePath, tools);
  const video = videoStreamOf(info);
  if (!video) {
    throw new YtError('That download was audio-only. Pick a video quality and try again.', 502);
  }

  const codec = String(video.codec_name || '').toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  const playable = isPlayableMacVideoCodec(codec);
  if (playable && ext === '.mp4') return { path: filePath, transcoded: false };

  if (!tools.ffmpeg || !tools.ffmpeg.ok || !tools.ffmpeg.path) {
    throw new YtError('Need ffmpeg to turn this into a playable MP4.', 502);
  }

  const dest = filePath.replace(/\.[^.]+$/, '') + '.mp4';
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}.mp4`;
  const args = playable
    ? ['-hide_banner', '-nostdin', '-y', '-i', filePath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp]
    : [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        tmp,
      ];

  log('transcode', playable ? 'remux' : codec, '→ h264 mp4', path.basename(filePath));
  const result = await runCaptured([tools.ffmpeg.path], args, 15 * 60 * 1000);
  const ok = result.code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0;
  if (!ok) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    const detail = lastMeaningfulError(result.stderr || result.stdout, '');
    throw new YtError(
      detail ? `Could not write a playable video: ${detail}` : 'Could not write a playable video file.',
      502
    );
  }

  try {
    fs.renameSync(tmp, dest);
  } catch {
    fs.copyFileSync(tmp, dest);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
  if (path.resolve(filePath) !== path.resolve(dest)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }
  return { path: dest, transcoded: !playable };
}

module.exports = {
  YTDLP_MISSING,
  VALID_FORMAT_IDS,
  YtError,
  getTools,
  probe,
  startDownload,
  killChild,
  killAllChildren,
  validateUrl,
  isPlaylistUrl,
  formatLabel,
  formatKind,
  pickOutputFile,
  lastMeaningfulError,
  parseProgressLine,
  is403Error,
  ensurePlayableVideo,
};
