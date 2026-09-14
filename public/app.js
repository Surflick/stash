(() => {
  "use strict";

  const LS_FORMAT = "stash.formatId";
  const LS_KIND = "stash.kind";

  const FORMAT_META = {
    best: { kind: "video", label: "Best" },
    2160: { kind: "video", label: "4K" },
    1440: { kind: "video", label: "1440p" },
    1080: { kind: "video", label: "1080p" },
    720: { kind: "video", label: "720p" },
    480: { kind: "video", label: "480p" },
    360: { kind: "video", label: "360p" },
    "audio-m4a": { kind: "audio", label: "M4A" },
    "audio-mp3": { kind: "audio", label: "MP3" },
  };
  const FORMAT_ORDER = Object.keys(FORMAT_META);

  const ACTIVE = new Set(["queued", "downloading", "merging"]);
  const THUMB_FALLBACK =
    '<div class="thumb-fallback" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3.25v11.2M7.15 10.4 12 15.25l4.85-4.85M5 17.35h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "") || navigator.userAgent.includes("Mac");

  const state = {
    probing: false,
    probe: null,
    kind: localStorage.getItem(LS_KIND) === "audio" ? "audio" : "video",
    formatId: (() => {
      const saved = localStorage.getItem(LS_FORMAT) || "best";
      const kind = localStorage.getItem(LS_KIND) === "audio" ? "audio" : "video";
      if (kind === "video" && String(saved).startsWith("audio-")) return "best";
      if (kind === "audio" && !String(saved).startsWith("audio-")) return "audio-m4a";
      return saved;
    })(),
    scope: "video",
    jobs: new Map(),
    library: [],
    settings: { outputDir: "" },
    health: null,
    tab: "queue",
    pollTimer: 0,
    sse: null,
    sseOk: false,
    probeAbort: null,
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    live: $("live"),
    url: $("url"),
    urlForm: $("url-form"),
    urlCard: $("url-card"),
    pasteHint: $("paste-hint"),
    clearBtn: $("clear-btn"),
    fetchBtn: $("fetch-btn"),
    tagline: $("tagline"),
    urlError: $("url-error"),
    skeleton: $("skeleton"),
    result: $("result"),
    thumb: $("result-thumb"),
    duration: $("result-duration"),
    livePill: $("result-live"),
    playlistBadge: $("result-playlist-badge"),
    title: $("result-title"),
    sub: $("result-sub"),
    playlistScope: $("playlist-scope"),
    kindSeg: $("kind-seg"),
    chips: $("format-chips"),
    liveNote: $("live-note"),
    formatEmpty: $("format-empty"),
    downloadBtn: $("download-btn"),
    tabQueue: $("tab-queue"),
    tabLibrary: $("tab-library"),
    panelQueue: $("panel-queue"),
    panelLibrary: $("panel-library"),
    queueEmpty: $("queue-empty"),
    queueList: $("queue-list"),
    queueCount: $("queue-count"),
    libraryEmpty: $("library-empty"),
    libraryList: $("library-list"),
    libraryCount: $("library-count"),
    folderBtn: $("folder-btn"),
    healthBtn: $("health-btn"),
    healthDot: $("health-dot"),
    healthLabel: $("health-label"),
    healthPop: $("health-pop"),
    healthYtdlp: $("health-ytdlp"),
    healthFfmpeg: $("health-ffmpeg"),
    healthBanner: $("health-banner"),
    settings: $("settings-dialog"),
    settingsForm: $("settings-form"),
    settingsClose: $("settings-close"),
    outputDir: $("output-dir"),
    saveDir: $("save-dir"),
    settingsMsg: $("settings-msg"),
    openFolder: $("open-folder"),
  };

  function announce(msg) {
    els.live.textContent = msg;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function show(el, on) {
    if (!el) return;
    el.hidden = !on;
  }

  function setText(el, text) {
    if (el) el.textContent = text ?? "";
  }

  async function api(path, { method = "GET", body, signal } = {}) {
    const res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    if (!res.ok) {
      const err = new Error(
        (data && (data.error || data.message || data.detail)) || res.statusText || "Request failed"
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function normalizeUrl(raw) {
    let s = String(raw || "").trim();
    if (!s) return "";
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) s = "https://" + s;
    return s;
  }

  function isYouTubeUrl(raw) {
    try {
      const u = new URL(normalizeUrl(raw));
      const h = u.hostname.replace(/^www\./i, "").toLowerCase();
      return (
        h === "youtu.be" ||
        h === "youtube.com" ||
        h === "m.youtube.com" ||
        h === "music.youtube.com" ||
        h === "youtube-nocookie.com"
      );
    } catch {
      return false;
    }
  }

  function isPlaylistOnlyUrl(raw) {
    try {
      const u = new URL(normalizeUrl(raw));
      return u.pathname.includes("/playlist") && u.searchParams.has("list") && !u.searchParams.has("v");
    } catch {
      return false;
    }
  }

  function formatBytes(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = x;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    const d = i === 0 || v >= 10 ? 0 : 1;
    return `${v.toFixed(d)} ${units[i]}`;
  }

  function formatViews(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    const fmt = (v, suffix) => `${v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
    if (x < 1000) return `${Math.round(x)} views`;
    if (x < 1e6) return `${fmt(x / 1e3, "K")} views`;
    if (x < 1e9) return `${fmt(x / 1e6, "M")} views`;
    return `${fmt(x / 1e9, "B")} views`;
  }

  function formatDuration(sec) {
    if (sec == null || sec === "") return "";
    if (typeof sec === "string" && /[:hms]/i.test(sec) && !/^\d+$/.test(sec)) return sec;
    const s = Math.max(0, Math.floor(Number(sec)));
    if (!Number.isFinite(s)) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function formatDate(raw) {
    if (raw == null || raw === "") return "";
    let d;
    const s = String(raw);
    if (/^\d{8}$/.test(s)) d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
    else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(`${s}T00:00:00`);
    else if (/^\d{10,13}$/.test(s)) d = new Date(s.length === 10 ? Number(s) * 1000 : Number(s));
    else d = new Date(raw);
    if (Number.isNaN(+d)) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatSpeed(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") return `${formatBytes(v)}/s`;
    return String(v);
  }

  function formatEta(v) {
    if (v == null || v === "") return "";
    if (typeof v === "number") return formatDuration(v);
    return String(v);
  }

  function pickThumb(data) {
    if (!data || typeof data !== "object") return "";
    if (typeof data.thumbnail === "string" && data.thumbnail) return data.thumbnail;
    const ts = data.thumbnails;
    if (Array.isArray(ts) && ts.length) {
      const sorted = [...ts].sort((a, b) => (Number(b.width) || Number(b.height) || 0) - (Number(a.width) || Number(a.height) || 0));
      const top = sorted[0];
      if (typeof top === "string") return top;
      return top?.url || "";
    }
    return "";
  }

  function unwrap(data) {
    if (!data || typeof data !== "object") return data;
    if (data.video && typeof data.video === "object") return { ...data, ...data.video };
    if (data.info && typeof data.info === "object") return { ...data, ...data.info };
    if (data.metadata && typeof data.metadata === "object") return { ...data, ...data.metadata };
    if (data.data && typeof data.data === "object" && (data.data.title || data.data.formats)) {
      return { ...data, ...data.data };
    }
    return data;
  }

  function kindOfFormat(f) {
    if (!f) return "video";
    if (f.kind === "audio" || f.kind === "video") return f.kind;
    if (f.type === "audio" || f.audioOnly || f.vcodec === "none") return "audio";
    const id = String(f.id || f.formatId || f.format_id || "");
    if (FORMAT_META[id]) return FORMAT_META[id].kind;
    if (/^audio/i.test(id)) return "audio";
    return "video";
  }

  function idOfFormat(f) {
    const id = String(f.id || f.formatId || f.format_id || "");
    if (FORMAT_META[id]) return id;
    const kind = kindOfFormat(f);
    const h = Number(f.height || f.resolution);
    if (kind === "audio") {
      const ext = String(f.ext || f.audioExt || "").toLowerCase();
      if (ext === "mp3" || id.includes("mp3")) return "audio-mp3";
      return "audio-m4a";
    }
    if (h >= 2160) return "2160";
    if (h >= 1440) return "1440";
    if (h >= 1080) return "1080";
    if (h >= 720) return "720";
    if (h >= 480) return "480";
    if (h >= 360) return "360";
    if (id === "best" || f.quality === "best") return "best";
    return id || "best";
  }

  function labelOfFormat(f, id) {
    return f.label || f.name || FORMAT_META[id]?.label || id;
  }

  function normalizeFormats(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const byId = new Map();
    for (const f of list) {
      const id = idOfFormat(f);
      if (!id) continue;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          kind: FORMAT_META[id]?.kind || kindOfFormat(f),
          label: labelOfFormat(f, id),
        });
      }
    }
    if (!byId.size) {
      for (const id of FORMAT_ORDER) {
        byId.set(id, { id, kind: FORMAT_META[id].kind, label: FORMAT_META[id].label });
      }
    } else {
      if (![...byId.values()].some((f) => f.kind === "video")) {
        byId.set("best", { id: "best", kind: "video", label: "Best" });
      }
      if (![...byId.values()].some((f) => f.kind === "audio")) {
        byId.set("audio-m4a", { id: "audio-m4a", kind: "audio", label: "M4A" });
        byId.set("audio-mp3", { id: "audio-mp3", kind: "audio", label: "MP3" });
      }
      if (![...byId.keys()].some((id) => FORMAT_META[id]?.kind === "video" && id !== "best")) {
        if (!byId.has("best")) byId.set("best", { id: "best", kind: "video", label: "Best" });
      }
    }
    return [...byId.values()].sort((a, b) => {
      const ia = FORMAT_ORDER.indexOf(a.id);
      const ib = FORMAT_ORDER.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }

  function normalizeProbe(raw, inputUrl) {
    const data = unwrap(raw) || {};
    const playlistCount = Number(
      data.playlistCount ?? data.playlist_count ?? data.n_entries ?? data.entries?.length ?? 0
    );
    const isPlaylist = Boolean(
      data.kind === "playlist" ||
        data.isPlaylist ||
        data.is_playlist ||
        data._type === "playlist" ||
        playlistCount > 1 ||
        isPlaylistOnlyUrl(inputUrl)
    );
    const duration = data.duration ?? data.duration_seconds;
    const durationLabel = data.durationText || formatDuration(duration);
    return {
      url: data.webpageUrl || data.webpage_url || data.original_url || data.url || inputUrl,
      title: data.title || data.fulltitle || data.playlist_title || "Untitled",
      channel: data.channel || data.uploader || data.channel_name || data.artist || "",
      thumbnail: data.thumbnail || pickThumb(data),
      duration,
      durationLabel,
      viewCount: data.viewCount ?? data.view_count ?? data.views,
      uploadDate: data.uploadDate || data.upload_date || data.release_date || data.timestamp,
      isLive: Boolean(data.isLive || data.is_live || data.live_status === "is_live"),
      isPlaylist,
      playlistCount,
      playlistTitle: data.playlist_title || data.playlistTitle || "",
      formats: normalizeFormats(data.formats || data.availableFormats),
    };
  }

  function asList(data, keys) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== "object") return [];
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  function normalizeJob(j) {
    if (!j || typeof j !== "object") return null;
    const id = j.id ?? j.jobId ?? j.job_id;
    if (id == null || id === "") return null;
    let percent = Number(j.percent ?? j.progress ?? 0);
    if (!Number.isFinite(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, percent));
    return {
      id: String(id),
      status: j.status || "queued",
      percent,
      speed: j.speed || "",
      eta: j.eta || "",
      title: j.title || "Untitled",
      thumbnail: j.thumbnail || pickThumb(j) || "",
      channel: j.channel || j.uploader || "",
      error: j.error || "",
      path: j.outputPath || j.path || j.filepath || "",
      formatId: j.formatId || j.format_id || "",
      playlist: Boolean(j.playlist),
      size: j.size ?? j.sizeBytes ?? j.total,
      url: j.url || "",
    };
  }

  function normalizeLibraryItem(it, i) {
    if (!it || typeof it !== "object") return null;
    const filePath = it.outputPath || it.path || it.filepath || it.file || "";
    return {
      id: String(it.id || filePath || i),
      title: it.title || it.filename || it.name || (filePath.split(/[/\\]/).pop() || "Untitled"),
      channel: it.channel || it.uploader || "",
      thumbnail: it.thumbnail || pickThumb(it) || "",
      path: filePath,
      size: it.sizeBytes ?? it.size ?? it.filesize ?? it.bytes,
      date: it.finishedAt || it.downloadedAt || it.mtime || it.createdAt || it.date || "",
      kind: it.kind || "",
    };
  }

  function flag(obj, keys) {
    for (const k of keys) {
      if (obj && typeof obj[k] === "boolean") return obj[k];
    }
    return null;
  }

  function readHealth(h) {
    const d = h && typeof h === "object" ? h : {};
    const y = typeof d.ytdlp === "object" && d.ytdlp ? d.ytdlp : {};
    const f = typeof d.ffmpeg === "object" && d.ffmpeg ? d.ffmpeg : {};
    const yVer =
      (typeof d.ytdlp === "string" ? d.ytdlp : "") || y.version || d.ytdlpVersion || "";
    const fVer = (typeof d.ffmpeg === "string" ? d.ffmpeg : "") || f.version || "";
    const yFlag = flag(y, ["ok", "installed", "available"]) ?? flag(d, ["hasYtdlp", "ytdlpOk"]);
    const fFlag =
      typeof d.ffmpeg === "boolean"
        ? d.ffmpeg
        : flag(f, ["ok", "installed", "available"]) ?? flag(d, ["hasFfmpeg", "ffmpegOk"]);
    return {
      ytdlpOk: yFlag == null ? Boolean(yVer) : yFlag,
      ytdlpVersion: String(yVer || "").replace(/^yt-dlp\s+/i, ""),
      ffmpegOk: fFlag == null ? Boolean(fVer) : fFlag,
      ffmpegVersion: String(fVer || "").replace(/^ffmpeg\s+/i, ""),
    };
  }

  function filteredFormats() {
    const probe = state.probe;
    if (!probe) return [];
    return probe.formats.filter((f) => f.kind === state.kind);
  }

  function preferredFormat(list) {
    const saved = state.formatId;
    if (list.some((f) => f.id === saved)) return saved;
    if (state.kind === "audio") {
      if (list.some((f) => f.id === "audio-m4a")) return "audio-m4a";
      return list[0]?.id || "audio-m4a";
    }
    for (const id of ["1080", "best", "720", "1440", "2160"]) {
      if (list.some((f) => f.id === id)) return id;
    }
    return list[0]?.id || "best";
  }

  function bindThumb(img, src) {
    if (!img) return;
    img.onload = () => img.setAttribute("data-empty", "false");
    img.onerror = () => img.setAttribute("data-empty", "true");
    if (src) {
      img.setAttribute("data-empty", "false");
      img.src = src;
    } else {
      img.removeAttribute("src");
      img.setAttribute("data-empty", "true");
    }
  }

  function syncUrlChrome() {
    const raw = els.url.value.trim();
    const valid = isYouTubeUrl(raw);
    show(els.clearBtn, Boolean(raw));
    show(els.pasteHint, !raw && !state.probing);
    show(els.fetchBtn, Boolean(raw) && valid);
    els.fetchBtn.disabled = state.probing || !valid;
    const spinning = state.probing;
    const spinner = els.fetchBtn.querySelector(".spinner");
    const label = els.fetchBtn.querySelector(".btn-label");
    if (spinner) spinner.hidden = !spinning;
    if (label) label.hidden = spinning;
  }

  function setProbeError(msg) {
    const text = msg || "";
    setText(els.urlError, text);
    show(els.urlError, Boolean(text));
    els.url.setAttribute("aria-invalid", text ? "true" : "false");
  }

  function renderHealth() {
    const h = state.health;
    if (!h) {
      els.healthDot.dataset.state = "unknown";
      setText(els.healthLabel, "Checking");
      return;
    }
    if (h.offline) {
      els.healthDot.dataset.state = "warn";
      setText(els.healthLabel, "Offline");
      setText(els.healthYtdlp, "Unreachable");
      setText(els.healthFfmpeg, "Unreachable");
      show(els.healthBanner, false);
      return;
    }
    if (!h.ytdlpOk) {
      els.healthDot.dataset.state = "bad";
      setText(els.healthLabel, "yt-dlp missing");
      setText(els.healthYtdlp, "Missing");
    } else {
      const ver = h.ytdlpVersion ? `yt-dlp ${h.ytdlpVersion}` : "yt-dlp";
      if (!h.ffmpegOk) {
        els.healthDot.dataset.state = "warn";
        setText(els.healthLabel, "ffmpeg missing");
      } else {
        els.healthDot.dataset.state = "ok";
        setText(els.healthLabel, ver);
      }
      setText(els.healthYtdlp, h.ytdlpVersion || "Ready");
    }
    setText(els.healthFfmpeg, h.ffmpegOk ? h.ffmpegVersion || "Ready" : "Missing");
    show(els.healthBanner, !h.ytdlpOk);
  }

  function renderChips() {
    const list = filteredFormats();
    els.chips.replaceChildren();
    if (!list.length) {
      show(els.formatEmpty, true);
      setText(
        els.formatEmpty,
        state.kind === "audio" ? "No audio formats for this video." : "No video formats for this video."
      );
      return;
    }
    show(els.formatEmpty, false);
    const selected = preferredFormat(list);
    state.formatId = selected;
    for (const f of list) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", f.id === selected ? "true" : "false");
      btn.dataset.format = f.id;
      btn.textContent = f.label;
      els.chips.appendChild(btn);
    }
  }

  function canDownload() {
    if (!state.probe || state.probing) return false;
    if (state.probe.isLive) return false;
    return filteredFormats().length > 0;
  }

  function renderResult() {
    const p = state.probe;
    show(els.skeleton, state.probing);
    show(els.result, Boolean(p) && !state.probing);
    show(els.tagline, !p && !state.probing);

    if (!p || state.probing) {
      els.downloadBtn.disabled = true;
      document.title = "Stash";
      return;
    }

    document.title = `${p.title} — Stash`;
    setText(els.title, p.title);
    bindThumb(els.thumb, p.thumbnail);
    els.thumb.alt = p.title ? `Thumbnail for ${p.title}` : "";

    const bits = [p.channel, formatViews(p.viewCount), formatDate(p.uploadDate)].filter(Boolean);
    setText(els.sub, bits.join(" · "));

    if (p.isLive) {
      show(els.livePill, true);
      show(els.duration, false);
    } else {
      show(els.livePill, false);
      show(els.duration, Boolean(p.durationLabel));
      setText(els.duration, p.durationLabel);
    }

    const showPlaylist = p.isPlaylist || p.playlistCount > 1;
    show(els.playlistScope, showPlaylist);
    if (showPlaylist) {
      const n = p.playlistCount;
      setText(els.playlistBadge, n > 1 ? `${n} videos` : "Playlist");
      show(els.playlistBadge, true);
    } else {
      show(els.playlistBadge, false);
    }

    for (const btn of els.playlistScope.querySelectorAll("[data-scope]")) {
      btn.setAttribute("aria-pressed", btn.dataset.scope === state.scope ? "true" : "false");
    }
    for (const btn of els.kindSeg.querySelectorAll("[data-kind]")) {
      btn.setAttribute("aria-pressed", btn.dataset.kind === state.kind ? "true" : "false");
    }

    renderChips();
    show(els.liveNote, p.isLive);
    const playlist = showPlaylist && state.scope === "playlist";
    setText(els.downloadBtn, playlist ? "Download playlist" : "Download");
    els.downloadBtn.disabled = !canDownload();
  }

  function statusLabel(job) {
    switch (job.status) {
      case "queued":
        return "Waiting";
      case "downloading":
        return "Downloading";
      case "merging":
        return "Merging";
      case "done":
        return "Saved";
      case "cancelled":
        return "Cancelled";
      case "error":
        return "Failed";
      default:
        return job.status;
    }
  }

  function displayPercent(job) {
    if (job.status === "done") return 100;
    if (job.status === "merging") return Math.max(Number(job.percent) || 0, 92);
    if (job.status === "queued") return Number(job.percent) || 0;
    return Math.max(0, Math.min(100, Number(job.percent) || 0));
  }

  function statsLine(job) {
    if (job.status === "done") return formatBytes(job.size);
    if (job.status !== "downloading" && job.status !== "merging") return "";
    const pct = `${Math.round(displayPercent(job))}%`;
    const speed = formatSpeed(job.speed);
    const eta = formatEta(job.eta);
    return [pct, speed, eta ? `ETA ${eta}` : ""].filter(Boolean).join("  ·  ");
  }

  function actionButtons(job) {
    if (ACTIVE.has(job.status)) {
      return `<button type="button" class="btn-mini btn-danger" data-action="cancel" data-id="${esc(job.id)}">Cancel</button>`;
    }
    if (job.status === "done" && job.path) {
      return `<button type="button" class="btn-mini" data-action="play" data-id="${esc(job.id)}">Play</button><button type="button" class="btn-mini" data-action="reveal" data-id="${esc(job.id)}">Finder</button>`;
    }
    if (job.status === "error" || job.status === "cancelled") {
      return `<button type="button" class="btn-mini" data-action="retry" data-id="${esc(job.id)}">Retry</button>`;
    }
    return "";
  }

  function jobTemplate(job) {
    const pct = displayPercent(job);
    const err = job.status === "error" && job.error ? `<p class="item-error">${esc(job.error)}</p>` : "";
    const thumb = job.thumbnail
      ? `<img src="${esc(job.thumbnail)}" alt="" decoding="async" referrerpolicy="no-referrer" data-empty="false">`
      : `<img alt="" data-empty="true">`;
    return `<article class="item" data-id="${esc(job.id)}" data-status="${esc(job.status)}">
      <div class="item-thumb">${thumb}${THUMB_FALLBACK}</div>
      <div class="item-body">
        <div class="item-top">
          <h3 class="item-title">${esc(job.title)}</h3>
          <div class="item-actions">${actionButtons(job)}</div>
        </div>
        <div class="item-meta">
          <span class="item-state">${esc(statusLabel(job))}</span>
          <span class="item-stats">${esc(statsLine(job))}</span>
        </div>
        ${err}
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Download progress">
          <div class="bar-fill" style="width:${pct}%"></div>
        </div>
      </div>
    </article>`;
  }

  function bindListThumbs(root) {
    root.querySelectorAll("img").forEach((img) => {
      img.addEventListener("error", () => img.setAttribute("data-empty", "true"), { once: true });
    });
  }

  function renderQueue() {
    const jobs = [...state.jobs.values()].sort((a, b) => {
      const aA = ACTIVE.has(a.status) ? 0 : 1;
      const bA = ACTIVE.has(b.status) ? 0 : 1;
      if (aA !== bA) return aA - bA;
      return (b._ts || 0) - (a._ts || 0);
    });
    const activeN = jobs.filter((j) => ACTIVE.has(j.status)).length;
    show(els.queueEmpty, jobs.length === 0);
    show(els.queueCount, activeN > 0);
    setText(els.queueCount, String(activeN));
    els.queueList.innerHTML = jobs.map(jobTemplate).join("");
    bindListThumbs(els.queueList);
  }

  function renderLibrary() {
    const items = state.library;
    show(els.libraryEmpty, items.length === 0);
    show(els.libraryCount, items.length > 0);
    setText(els.libraryCount, String(items.length));
    els.libraryList.innerHTML = items
      .map((it) => {
        const meta = [it.channel, formatBytes(it.size), formatDate(it.date)].filter(Boolean).join(" · ");
        const thumb = it.thumbnail
          ? `<img src="${esc(it.thumbnail)}" alt="" decoding="async" referrerpolicy="no-referrer" data-empty="false">`
          : `<img alt="" data-empty="true">`;
        const actions = it.path
          ? `<button type="button" class="btn-mini" data-action="open" data-path="${esc(it.path)}">Open</button><button type="button" class="btn-mini" data-action="reveal" data-path="${esc(it.path)}">Finder</button>`
          : "";
        return `<article class="item">
          <div class="item-thumb">${thumb}${THUMB_FALLBACK}</div>
          <div class="item-body">
            <div class="item-top">
              <h3 class="item-title">${esc(it.title)}</h3>
              <div class="item-actions">${actions}</div>
            </div>
            <div class="item-meta">
              <span class="item-state">${esc(meta)}</span>
            </div>
          </div>
        </article>`;
      })
      .join("");
    bindListThumbs(els.libraryList);
  }

  function setTab(tab) {
    state.tab = tab;
    const queue = tab === "queue";
    els.tabQueue.setAttribute("aria-selected", queue ? "true" : "false");
    els.tabLibrary.setAttribute("aria-selected", queue ? "false" : "true");
    show(els.panelQueue, queue);
    show(els.panelLibrary, !queue);
  }

  function upsertJob(incoming, extra = {}) {
    const n = normalizeJob(incoming);
    if (!n) return;
    if (!String(n.id).startsWith("tmp-")) {
      for (const [id, job] of state.jobs) {
        if (
          id.startsWith("tmp-") &&
          (job.url === n.url || job.title === n.title) &&
          ACTIVE.has(job.status)
        ) {
          state.jobs.delete(id);
          extra._payload = extra._payload || job._payload;
          extra._ts = job._ts;
          break;
        }
      }
    }
    const prev = state.jobs.get(n.id) || {};
    const merged = {
      ...prev,
      ...n,
      ...extra,
      _payload: extra._payload || n._payload || prev._payload,
      _ts: extra._ts || prev._ts || Date.now(),
    };
    const wasDone = prev.status === "done";
    state.jobs.set(n.id, merged);
    renderQueue();
    if (merged.status === "done" && !wasDone) {
      announce(`Saved ${merged.title}`);
      loadLibrary();
    }
    if (merged.status === "error" && prev.status !== "error") {
      announce(merged.error || "Download failed");
    }
  }

  async function probe() {
    const raw = els.url.value.trim();
    if (!raw) {
      setProbeError("Paste a YouTube link first.");
      return;
    }
    const url = normalizeUrl(raw);
    if (!isYouTubeUrl(url)) {
      setProbeError("Use a youtube.com or youtu.be link.");
      return;
    }

    if (state.probeAbort) state.probeAbort.abort();
    const ac = new AbortController();
    state.probeAbort = ac;
    state.probing = true;
    state.probe = null;
    setProbeError("");
    syncUrlChrome();
    renderResult();
    announce("Looking up video");

    try {
      const data = await api("/api/probe", { method: "POST", body: { url }, signal: ac.signal });
      const p = normalizeProbe(data, url);
      state.scope = p.isPlaylist && isPlaylistOnlyUrl(url) ? "playlist" : "video";
      state.probe = p;
      state.formatId = preferredFormat(p.formats.filter((f) => f.kind === state.kind));
      announce(p.title);
    } catch (err) {
      if (err.name === "AbortError") return;
      state.probe = null;
      setProbeError(err.message || "Couldn’t fetch that link.");
      announce("Couldn’t fetch that link");
    } finally {
      if (state.probeAbort === ac) state.probeAbort = null;
      state.probing = false;
      syncUrlChrome();
      renderResult();
    }
  }

  async function startDownload(payload, replaceId) {
    const tmpId = replaceId || `tmp-${Date.now()}`;
    upsertJob(
      {
        id: tmpId,
        status: "queued",
        percent: 0,
        title: payload.title || "Untitled",
        thumbnail: payload.thumbnail || "",
        channel: payload.channel || "",
        url: payload.url,
        formatId: payload.formatId,
        playlist: payload.playlist,
      },
      { _payload: payload, _ts: Date.now() }
    );
    setTab("queue");
    announce("Download added to queue");
    try {
      const res = await api("/api/download", { method: "POST", body: payload });
      const job = res?.job || res;
      const real = normalizeJob(job);
      if (real && real.id && real.id !== tmpId) {
        const prev = state.jobs.get(tmpId);
        state.jobs.delete(tmpId);
        upsertJob(real, { _payload: payload, _ts: prev?._ts || Date.now() });
      } else if (real) {
        upsertJob(real, { _payload: payload });
      }
    } catch (err) {
      upsertJob(
        { id: tmpId, status: "error", error: err.message || "Download failed", title: payload.title },
        { _payload: payload }
      );
    }
  }

  function download() {
    const p = state.probe;
    if (!p || !canDownload()) return;
    const payload = {
      url: p.url,
      formatId: state.formatId,
      playlist: Boolean((p.isPlaylist || p.playlistCount > 1) && state.scope === "playlist"),
      title: p.title,
      thumbnail: p.thumbnail,
      channel: p.channel,
    };
    localStorage.setItem(LS_FORMAT, state.formatId);
    localStorage.setItem(LS_KIND, state.kind);
    startDownload(payload);
  }

  async function cancelJob(id) {
    const job = state.jobs.get(id);
    if (!job) return;
    if (String(id).startsWith("tmp-")) {
      upsertJob({ ...job, status: "cancelled" });
      return;
    }
    try {
      await api(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
      upsertJob({ ...job, id, status: "cancelled" });
    } catch (err) {
      announce(err.message || "Couldn’t cancel");
    }
  }

  function retryJob(id) {
    const job = state.jobs.get(id);
    if (!job) return;
    const payload = job._payload || {
      url: job.url,
      formatId: job.formatId || state.formatId,
      playlist: job.playlist,
      title: job.title,
      thumbnail: job.thumbnail,
      channel: job.channel,
    };
    if (!payload.url) {
      announce("Nothing to retry — paste the link again.");
      return;
    }
    startDownload(payload, job.id);
  }

  async function openPath(path, reveal) {
    if (!path) return;
    try {
      await api("/api/open", { method: "POST", body: reveal ? { path, reveal: true } : { path } });
    } catch (err) {
      announce(err.message || "Couldn’t open file");
    }
  }

  async function openFolder() {
    try {
      await api("/api/open-folder", { method: "POST", body: {} });
    } catch (err) {
      announce(err.message || "Couldn’t open folder");
    }
  }

  async function loadJobs() {
    try {
      const data = await api("/api/jobs");
      const list = asList(data, ["jobs", "items", "queue"]);
      for (const j of list) upsertJob(j);
      if (!list.length) renderQueue();
    } catch {
      /* keep local queue */
    }
  }

  async function loadLibrary() {
    try {
      const data = await api("/api/library");
      const list = asList(data, ["items", "library", "files", "downloads"]);
      state.library = list.map(normalizeLibraryItem).filter(Boolean);
      renderLibrary();
    } catch {
      if (!state.library.length) {
        setText(els.libraryEmpty, "Couldn’t load library.");
        show(els.libraryEmpty, true);
      }
    }
  }

  async function loadSettings() {
    try {
      const data = await api("/api/settings");
      const dir = data?.outputDir || data?.output || data?.dir || "";
      state.settings.outputDir = dir;
      if (dir && !els.outputDir.value) els.outputDir.value = dir;
      else if (dir && document.activeElement !== els.outputDir) els.outputDir.value = dir;
    } catch {
      /* settings stay local */
    }
  }

  async function saveSettings() {
    const outputDir = els.outputDir.value.trim();
    show(els.settingsMsg, false);
    try {
      const data = await api("/api/settings", { method: "PUT", body: { outputDir } });
      state.settings.outputDir = data?.outputDir || outputDir;
      els.outputDir.value = state.settings.outputDir;
      els.settingsMsg.dataset.kind = "ok";
      setText(els.settingsMsg, "Saved");
      show(els.settingsMsg, true);
      announce("Save location updated");
    } catch (err) {
      els.settingsMsg.dataset.kind = "error";
      setText(els.settingsMsg, err.message || "Couldn’t save");
      show(els.settingsMsg, true);
    }
  }

  async function loadHealth() {
    try {
      const data = await api("/api/health");
      state.health = readHealth(data);
      if (data && data.outputDir && !state.settings.outputDir) {
        state.settings.outputDir = data.outputDir;
        if (!els.outputDir.value) els.outputDir.value = data.outputDir;
      }
    } catch {
      state.health = { ytdlpOk: true, ytdlpVersion: "", ffmpegOk: true, offline: true };
    }
    renderHealth();
  }

  function startPoll() {
    if (state.pollTimer) return;
    state.pollTimer = window.setInterval(() => {
      if (document.hidden) return;
      loadJobs();
    }, 1000);
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = 0;
    }
  }

  function onSsePayload(raw) {
    state.sseOk = true;
    stopPoll();
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        data.forEach((j) => upsertJob(j));
        return;
      }
      if (data && data.id) upsertJob(data);
    } catch {
      /* ignore malformed event */
    }
  }

  function connectSSE() {
    if (typeof EventSource === "undefined") {
      startPoll();
      return;
    }
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    let fails = 0;
    try {
      const es = new EventSource("/api/events");
      state.sse = es;
      const onJob = (ev) => {
        fails = 0;
        if (ev.data) onSsePayload(ev.data);
      };
      es.addEventListener("job", onJob);
      es.onerror = () => {
        fails += 1;
        if (fails >= 2) startPoll();
      };
    } catch {
      startPoll();
    }
  }

  function openSettings() {
    els.outputDir.value = state.settings.outputDir || els.outputDir.value;
    show(els.settingsMsg, false);
    if (typeof els.settings.showModal === "function") els.settings.showModal();
    else els.settings.setAttribute("open", "");
    queueMicrotask(() => els.outputDir.focus());
  }

  function closeSettings() {
    if (typeof els.settings.close === "function") els.settings.close();
    else els.settings.removeAttribute("open");
  }

  function closeHealthPop() {
    show(els.healthPop, false);
    els.healthBtn.setAttribute("aria-expanded", "false");
  }

  function onUrlInput() {
    syncUrlChrome();
    if (!els.url.value.trim()) {
      state.probe = null;
      setProbeError("");
      renderResult();
    }
  }

  function onPaste() {
    queueMicrotask(() => {
      const raw = els.url.value.trim();
      if (isYouTubeUrl(raw)) probe();
    });
  }

  els.urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    probe();
  });

  els.url.addEventListener("input", onUrlInput);
  els.url.addEventListener("paste", onPaste);

  els.clearBtn.addEventListener("click", () => {
    els.url.value = "";
    state.probe = null;
    setProbeError("");
    syncUrlChrome();
    renderResult();
    els.url.focus();
  });

  els.kindSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kind]");
    if (!btn) return;
    state.kind = btn.dataset.kind;
    localStorage.setItem(LS_KIND, state.kind);
    const list = filteredFormats();
    state.formatId = preferredFormat(list);
    renderResult();
  });

  els.playlistScope.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-scope]");
    if (!btn) return;
    state.scope = btn.dataset.scope;
    renderResult();
  });

  els.chips.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-format]");
    if (!btn) return;
    state.formatId = btn.dataset.format;
    localStorage.setItem(LS_FORMAT, state.formatId);
    for (const c of els.chips.querySelectorAll(".chip")) {
      c.setAttribute("aria-checked", c.dataset.format === state.formatId ? "true" : "false");
    }
  });

  els.downloadBtn.addEventListener("click", download);

  els.tabQueue.addEventListener("click", () => setTab("queue"));
  els.tabLibrary.addEventListener("click", () => {
    setTab("library");
    loadLibrary();
  });

  els.queueList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const job = id ? state.jobs.get(id) : null;
    const path = btn.dataset.path || job?.path || "";
    if (btn.dataset.action === "cancel") cancelJob(id);
    if (btn.dataset.action === "retry") retryJob(id);
    if (btn.dataset.action === "play" || btn.dataset.action === "open") openPath(path, false);
    if (btn.dataset.action === "reveal") openPath(path, true);
  });

  els.libraryList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const path = btn.dataset.path || "";
    if (btn.dataset.action === "open") openPath(path, false);
    if (btn.dataset.action === "reveal") openPath(path, true);
  });

  els.folderBtn.addEventListener("click", () => {
    closeHealthPop();
    loadSettings();
    openSettings();
  });

  els.saveDir.addEventListener("click", saveSettings);
  els.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings();
  });
  els.settingsClose.addEventListener("click", closeSettings);
  els.openFolder.addEventListener("click", openFolder);

  els.healthBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = els.healthPop.hidden;
    show(els.healthPop, open);
    els.healthBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  document.addEventListener("click", (e) => {
    if (!els.healthPop.hidden && !e.target.closest(".health-wrap")) closeHealthPop();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHealthPop();
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === "Enter") {
      e.preventDefault();
      if (state.probe && !state.probing) download();
      else probe();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      loadJobs();
      loadHealth();
      if (state.tab === "library") loadLibrary();
    }
  });

  els.pasteHint.textContent = isMac ? "⌘V" : "Ctrl+V";

  function init() {
    syncUrlChrome();
    renderResult();
    renderQueue();
    renderLibrary();
    renderHealth();
    els.url.focus();
    loadHealth();
    loadSettings();
    loadJobs();
    loadLibrary();
    connectSSE();
    const q = new URLSearchParams(location.search).get("url");
    if (q && isYouTubeUrl(q)) {
      els.url.value = q.trim();
      syncUrlChrome();
      probe();
    }
  }

  init();
})();
