'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const MAX_HISTORY = 500;

function defaultOutputDir() {
  return path.join(os.homedir(), 'Downloads');
}

function log(...args) {
  console.log('[stash]', ...args);
}

function atomicWriteSync(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonSync(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let settings = { outputDir: defaultOutputDir() };
let history = [];

function normalizeSettings(raw) {
  const out = { outputDir: defaultOutputDir() };
  if (raw && typeof raw === 'object' && typeof raw.outputDir === 'string' && raw.outputDir.trim()) {
    out.outputDir = path.resolve(raw.outputDir.trim());
  }
  return out;
}

function normalizeHistory(raw) {
  let entries = [];
  if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) entries = raw.entries;
  return entries.filter((e) => e && typeof e === 'object');
}

function saveSettings() {
  atomicWriteSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
}

function saveHistory() {
  atomicWriteSync(HISTORY_FILE, JSON.stringify({ entries: history }, null, 2) + '\n');
}

function ensureDir(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true });
  const st = fs.statSync(resolved);
  if (!st.isDirectory()) {
    const err = new Error('Path is not a directory');
    err.code = 'ENOTDIR';
    throw err;
  }
  return resolved;
}

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  settings = normalizeSettings(readJsonSync(SETTINGS_FILE, null));
  history = normalizeHistory(readJsonSync(HISTORY_FILE, { entries: [] }));
  try {
    settings.outputDir = ensureDir(settings.outputDir);
  } catch (err) {
    log('could not use saved outputDir, falling back:', err.message);
    settings.outputDir = ensureDir(defaultOutputDir());
  }
  saveSettings();
  if (!fs.existsSync(HISTORY_FILE)) saveHistory();
  log('output dir', settings.outputDir);
  return settings;
}

function getSettings() {
  return { outputDir: settings.outputDir };
}

function setOutputDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) {
    const err = new Error('outputDir is required');
    err.status = 400;
    throw err;
  }
  let resolved;
  try {
    resolved = path.resolve(dir.trim().replace(/^~(?=$|[/\\])/, os.homedir()));
  } catch {
    const err = new Error('Invalid output directory');
    err.status = 400;
    throw err;
  }
  try {
    settings.outputDir = ensureDir(resolved);
  } catch (err) {
    const wrapped = new Error(
      err.code === 'ENOTDIR'
        ? 'That path exists and is not a directory'
        : err.code === 'EACCES' || err.code === 'EPERM'
          ? 'Permission denied creating that folder'
          : 'Could not create that folder'
    );
    wrapped.status = 400;
    throw wrapped;
  }
  saveSettings();
  log('output dir set', settings.outputDir);
  return getSettings();
}

function getHistory() {
  return history.slice();
}

function addHistory(entry) {
  const row = {
    id: entry.id,
    url: entry.url || null,
    title: entry.title || null,
    thumbnail: entry.thumbnail || null,
    channel: entry.channel || null,
    formatId: entry.formatId || null,
    formatLabel: entry.formatLabel || null,
    kind: entry.kind || 'video',
    outputPath: entry.outputPath,
    filename: entry.filename || (entry.outputPath ? path.basename(entry.outputPath) : null),
    sizeBytes: Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null,
    finishedAt: entry.finishedAt || new Date().toISOString(),
  };
  history = [row, ...history.filter((e) => e.outputPath !== row.outputPath || e.id === row.id)].slice(0, MAX_HISTORY);
  saveHistory();
  return row;
}

function getLibrary() {
  const items = [];
  for (const entry of history) {
    if (!entry.outputPath) continue;
    try {
      const st = fs.statSync(entry.outputPath);
      if (!st.isFile()) continue;
      items.push({
        id: entry.id,
        url: entry.url || null,
        title: entry.title || entry.filename || path.basename(entry.outputPath),
        thumbnail: entry.thumbnail || null,
        channel: entry.channel || null,
        formatId: entry.formatId || null,
        formatLabel: entry.formatLabel || null,
        kind: entry.kind || 'video',
        outputPath: entry.outputPath,
        filename: entry.filename || path.basename(entry.outputPath),
        sizeBytes: st.size,
        finishedAt: entry.finishedAt || null,
      });
    } catch {
      // file moved or deleted
    }
  }
  items.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  return items;
}

module.exports = {
  DATA_DIR,
  defaultOutputDir,
  init,
  getSettings,
  setOutputDir,
  getHistory,
  addHistory,
  getLibrary,
  ensureDir,
};
