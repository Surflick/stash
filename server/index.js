'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');

const store = require('./store');
const ytdlp = require('./ytdlp');

const PORT = Number(process.env.PORT) || 47841;
const HOST = '127.0.0.1';
const MAX_CONCURRENT = 2;
const MAX_FINISHED_JOBS = 100;
const VERSION = '1.2.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

process.title = 'stash';

function log(...args) {
  console.log('[stash]', ...args);
}

store.init();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/events') {
    log(req.method, req.path);
  }
  next();
});

const jobs = new Map();
const sseClients = new Set();
let runningCount = 0;
let pumping = false;
let shuttingDown = false;

function nowIso() {
  return new Date().toISOString();
}

function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    thumbnail: job.thumbnail,
    channel: job.channel,
    formatId: job.formatId,
    formatLabel: job.formatLabel,
    kind: job.kind,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    downloaded: job.downloaded,
    total: job.total,
    outputPath: job.outputPath,
    filename: job.filename,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function sendSse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${data == null ? '' : JSON.stringify(data)}\n\n`);
}

function emitJob(job) {
  const payload = publicJob(job);
  const dead = [];
  for (const client of sseClients) {
    try {
      sendSse(client, 'job', payload);
    } catch {
      dead.push(client);
    }
  }
  for (const client of dead) sseClients.delete(client);
}

function bump(job, immediate = false) {
  job.updatedAt = nowIso();
  const t = Date.now();
  if (immediate || !job._lastEmit || t - job._lastEmit >= 200) {
    job._lastEmit = t;
    emitJob(job);
  }
}

function listJobs() {
  return [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function trimFinishedJobs() {
  const finished = listJobs().filter((j) => ['done', 'error', 'cancelled'].includes(j.status));
  if (finished.length <= MAX_FINISHED_JOBS) return;
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    if (!job.child) jobs.delete(job.id);
  }
}

function expandPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(s);
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isSafeOpenPath(target) {
  const home = os.homedir();
  const outputDir = store.getSettings().outputDir;
  return isInside(target, home) || isInside(target, outputDir);
}

function openPath(target, reveal) {
  return new Promise((resolve, reject) => {
    const args = reveal ? ['-R', target] : [target];
    const child = spawn('open', args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Could not open in Finder'));
    });
    child.unref();
  });
}

function sendError(res, err, fallbackStatus = 500) {
  const status = Number(err && err.status) || fallbackStatus;
  const expose = status < 500 || (err && err.name === 'YtError') || (err && err.status);
  const message = expose ? (err && err.message) || 'Something went wrong.' : 'Something went wrong.';
  if (status >= 500) log('error', err && err.stack ? err.stack : message);
  res.status(status).json({ ok: false, error: message });
}

function createJob(body, url) {
  const formatId = ytdlp.VALID_FORMAT_IDS.has(body.formatId) ? body.formatId : 'best';
  const createdAt = nowIso();
  return {
    id: crypto.randomUUID(),
    url,
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null,
    thumbnail: typeof body.thumbnail === 'string' ? body.thumbnail : null,
    channel: typeof body.channel === 'string' && body.channel.trim() ? body.channel.trim() : null,
    formatId,
    formatLabel: ytdlp.formatLabel(formatId),
    kind: ytdlp.formatKind(formatId),
    status: 'queued',
    percent: 0,
    speed: null,
    eta: null,
    downloaded: null,
    total: null,
    outputPath: null,
    filename: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    playlist: !!body.playlist,
    child: null,
    cancelRequested: false,
    handle: null,
    killTimer: null,
    slotReleased: false,
    _finished: false,
    _lastEmit: 0,
  };
}

function releaseSlot(job) {
  if (job.slotReleased) return;
  job.slotReleased = true;
  runningCount = Math.max(0, runningCount - 1);
}

function finishJob(job, status, extra = {}) {
  if (job._finished) return;
  job._finished = true;
  if (job.killTimer) {
    clearTimeout(job.killTimer);
    job.killTimer = null;
  }
  job.child = null;
  job.handle = null;
  job.status = status;
  if (extra.error != null) job.error = extra.error;
  if (extra.outputPath) {
    job.outputPath = extra.outputPath;
    job.filename = path.basename(extra.outputPath);
  }
  if (status === 'done') {
    job.percent = 100;
    job.speed = null;
    job.eta = null;
    job.error = null;
  }
  if (status === 'cancelled') {
    job.error = null;
  }
  releaseSlot(job);
  bump(job, true);
  trimFinishedJobs();
  pump();
}

function pickQueued() {
  for (const job of jobs.values()) {
    if (job.status === 'queued' && !job.cancelRequested) return job;
  }
  return null;
}

function pump() {
  if (pumping || shuttingDown) return;
  pumping = true;
  try {
    while (runningCount < MAX_CONCURRENT) {
      const next = pickQueued();
      if (!next) break;
      next.status = 'downloading';
      next.percent = next.percent || 0;
      runningCount += 1;
      bump(next, true);
      void runJob(next);
    }
  } finally {
    pumping = false;
  }
}

async function finalizeDownload(job, handle, code) {
  if (job._finished) return;
  const destinations = handle.getDestinations();
  const outputDir = store.getSettings().outputDir;
  let outputPath = ytdlp.pickOutputFile(destinations, outputDir, { kind: job.kind });
  if (code === 0) {
    let st = null;
    if (outputPath) {
      try {
        st = fs.statSync(outputPath);
      } catch {
        st = null;
      }
    }
    if (!st || !st.isFile()) {
      finishJob(job, 'error', { error: 'Download finished but the file could not be found.' });
      return;
    }
    if (job.kind === 'video') {
      job.status = 'merging';
      job.percent = Math.max(job.percent || 0, 99);
      job.speed = null;
      job.eta = null;
      bump(job, true);
      try {
        const ensured = await ytdlp.ensurePlayableVideo(outputPath);
        outputPath = ensured.path;
        st = fs.statSync(outputPath);
      } catch (err) {
        finishJob(job, 'error', { error: (err && err.message) || 'Could not write a playable video file.' });
        return;
      }
    }
    if (!job.title) {
      const base = path.basename(outputPath).replace(/\.[^.]+$/, '');
      job.title = base.replace(/\s+\[[^\]]+\]$/, '') || base;
    }
    job.filename = path.basename(outputPath);
    job.outputPath = outputPath;
    try {
      store.addHistory({
        id: job.id,
        url: job.url,
        title: job.title,
        thumbnail: job.thumbnail,
        channel: job.channel,
        formatId: job.formatId,
        formatLabel: job.formatLabel,
        kind: job.kind,
        outputPath,
        filename: job.filename,
        sizeBytes: st.size,
        finishedAt: nowIso(),
      });
    } catch (err) {
      log('history save failed', err.message);
    }
    finishJob(job, 'done', { outputPath });
    log('done', job.filename);
    return;
  }
  const rawLog = typeof handle.getLog === 'function' ? handle.getLog() : handle.getStderr();
  const errText = ytdlp.lastMeaningfulError(rawLog, `yt-dlp exited with code ${code}`);
  if (!job._androidRetry && ytdlp.is403Error(rawLog + '\n' + errText)) {
    job._androidRetry = true;
    log('403 — retrying with android client', job.id);
    job.status = 'downloading';
    job.percent = 0;
    job.speed = null;
    job.eta = null;
    job.error = null;
    bump(job, true);
    job.child = null;
    job.handle = null;
    void runJob(job, ['--extractor-args', 'youtube:player_client=android']);
    return;
  }
  finishJob(job, 'error', { error: errText });
  log('failed', job.id, errText);
}

async function runJob(job, extraArgs) {
  if (job.cancelRequested) {
    finishJob(job, 'cancelled');
    return;
  }
  let handle;
  try {
    handle = await ytdlp.startDownload({
      url: job.url,
      formatId: job.formatId,
      playlist: job.playlist,
      extraArgs,
      outputDir: store.getSettings().outputDir,
      onProgress: (p) => {
        if (job._finished || job.cancelRequested) return;
        if (job.status === 'downloading' || job.status === 'merging') {
          if (p.percent != null) job.percent = p.percent;
          if (p.speed !== undefined) job.speed = p.speed;
          if (p.eta !== undefined) job.eta = p.eta;
          if (p.downloaded !== undefined) job.downloaded = p.downloaded;
          if (p.total !== undefined) job.total = p.total;
          bump(job, false);
        }
      },
      onStatus: (status) => {
        if (job._finished || job.cancelRequested) return;
        if (status === 'merging' && job.status === 'downloading') {
          job.status = 'merging';
          job.percent = Math.max(job.percent, 99);
          job.speed = null;
          job.eta = null;
          bump(job, true);
        }
      },
    });
  } catch (err) {
    finishJob(job, 'error', { error: err.message || 'Could not start download.' });
    return;
  }

  job.handle = handle;
  job.child = handle.child;
  const child = handle.child;

  const onChildError = (err) => {
    if (job._finished) return;
    const msg =
      err && err.code === 'ENOENT'
        ? ytdlp.YTDLP_MISSING
        : (err && err.message) || 'Failed to start yt-dlp.';
    finishJob(job, job.cancelRequested ? 'cancelled' : 'error', { error: msg });
  };

  const onChildClose = (code) => {
    if (job._finished) return;
    try {
      handle.flush();
    } catch {
      // ignore
    }
    if (job.cancelRequested) {
      finishJob(job, 'cancelled');
      return;
    }
    void finalizeDownload(job, handle, code);
  };

  child.on('error', onChildError);
  child.on('close', onChildClose);
  if (child.exitCode != null || child.signalCode != null) {
    onChildClose(child.exitCode);
    return;
  }
  if (job.cancelRequested) cancelRunning(job);
}

function cancelRunning(job) {
  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    bump(job, true);
    return;
  }
  if (!job.child) return;
  log('cancel', job.id, 'pid', job.child.pid);
  ytdlp.killChild(job.child, 'SIGTERM');
  if (job.killTimer) clearTimeout(job.killTimer);
  job.killTimer = setTimeout(() => {
    if (job._finished || !job.child) return;
    log('cancel SIGKILL', job.id, 'pid', job.child.pid);
    ytdlp.killChild(job.child, 'SIGKILL');
  }, 2000);
}

app.get('/api/health', async (_req, res) => {
  try {
    const tools = await ytdlp.getTools(true);
    res.json({
      ok: true,
      app: 'stash',
      version: VERSION,
      ytdlp: {
        ok: !!tools.ytdlp.ok,
        version: tools.ytdlp.version,
        cmd: tools.ytdlp.cmd,
      },
      ffmpeg: {
        ok: !!tools.ffmpeg.ok,
        version: tools.ffmpeg.version,
        path: tools.ffmpeg.path,
      },
      outputDir: store.getSettings().outputDir,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/settings', (_req, res) => {
  res.json(store.getSettings());
});

app.put('/api/settings', (req, res) => {
  try {
    const outputDir = req.body && req.body.outputDir;
    res.json(store.setOutputDir(outputDir));
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.post('/api/probe', async (req, res) => {
  try {
    const url = req.body && req.body.url;
    const info = await ytdlp.probe(url);
    res.json(info);
  } catch (err) {
    sendError(res, err, err.status || 502);
  }
});

app.post('/api/download', (req, res) => {
  try {
    const body = req.body || {};
    const url = ytdlp.validateUrl(body.url);
    if (body.formatId && !ytdlp.VALID_FORMAT_IDS.has(body.formatId)) {
      res.status(400).json({ ok: false, error: 'Unknown format. Pick a quality from the list.' });
      return;
    }
    const job = createJob(body, url);
    jobs.set(job.id, job);
    bump(job, true);
    pump();
    res.json({ ok: true, job: publicJob(job) });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listJobs().map(publicJob) });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Job not found' });
    return;
  }
  res.json({ ok: true, job: publicJob(job) });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Job not found' });
    return;
  }
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    res.json({ ok: true, job: publicJob(job) });
    return;
  }
  if (job.status === 'queued') {
    job.cancelRequested = true;
    job.status = 'cancelled';
    bump(job, true);
    res.json({ ok: true, job: publicJob(job) });
    return;
  }
  cancelRunning(job);
  if (job.status === 'downloading' || job.status === 'merging') {
    // status flips to cancelled when the child exits
  }
  bump(job, true);
  res.json({ ok: true, job: publicJob(job) });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  try {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
  } catch {
    // ignore
  }
  sendSse(res, 'hello', { ok: true });
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 20_000);
  if (heartbeat.unref) heartbeat.unref();
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.post('/api/open', async (req, res) => {
  try {
    const target = expandPath(req.body && req.body.path);
    if (!target) {
      res.status(400).json({ ok: false, error: 'path is required' });
      return;
    }
    if (!isSafeOpenPath(target)) {
      res.status(400).json({ ok: false, error: 'That path is outside the allowed folders.' });
      return;
    }
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      res.status(404).json({ ok: false, error: 'File not found' });
      return;
    }
    // Play opens the file; Finder reveals it. Folders always open.
    const reveal = st.isDirectory() ? false : req.body && req.body.reveal === true;
    await openPath(target, reveal);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 500);
  }
});

app.post('/api/open-folder', async (_req, res) => {
  try {
    const dir = store.getSettings().outputDir;
    store.ensureDir(dir);
    await openPath(dir, false);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err, 500);
  }
});

app.get('/api/library', (_req, res) => {
  res.json({ items: store.getLibrary() });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  const indexFile = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    app.get('*', (_req, res) => {
      res.sendFile(indexFile);
    });
  }
}

app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    res.status(400).json({ ok: false, error: 'Invalid JSON body' });
    return;
  }
  sendError(res, err);
});

const server = app.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  ytdlp
    .getTools(true)
    .then((tools) => {
      log('yt-dlp', tools.ytdlp.ok ? tools.ytdlp.version : 'missing', (tools.ytdlp.cmd || []).join(' '));
      log('ffmpeg', tools.ffmpeg.ok ? tools.ffmpeg.version : 'missing', tools.ffmpeg.path || '');
    })
    .catch((err) => log('tool check failed', err.message));
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${signal})`);
  for (const job of jobs.values()) {
    if (job.child) {
      job.cancelRequested = true;
      ytdlp.killChild(job.child, 'SIGTERM');
    }
  }
  ytdlp.killAllChildren();
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // ignore
    }
  }
  sseClients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  log('uncaughtException', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  log('unhandledRejection', err && err.stack ? err.stack : err);
});
