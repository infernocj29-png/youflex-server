// ============================================================
// YOUFLEX Download Manager v4.0
// Strategy: yt-dlp for trailers, open MP4 sources for content
// ============================================================

const API_BASE_DL = 'https://youflex-server-production.up.railway.app/api';

// ── UI helpers ───────────────────────────────────────────────
function createDownloadModal(title) {
  const existing = document.getElementById('yfxDownloadModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'yfxDownloadModal';
  modal.innerHTML = `
    <div id="yfxDlOverlay" style="
      position:fixed;inset:0;background:rgba(0,0,0,0.82);
      backdrop-filter:blur(8px);z-index:99999;
      display:flex;align-items:center;justify-content:center;padding:1rem;">
      <div style="
        background:#0d111a;border:1px solid rgba(255,255,255,0.1);
        border-radius:20px;padding:2rem;width:100%;max-width:440px;
        box-shadow:0 24px 80px rgba(0,0,0,0.9);position:relative;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px;">
          <span style="font-size:1.6rem;">⬇️</span>
          <span style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:2px;color:#fff;">DOWNLOAD</span>
        </div>
        <div style="color:rgba(255,255,255,0.5);font-size:0.85rem;margin-bottom:1.4rem;">${title}</div>
        <div id="yfxDlBody"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#yfxDlOverlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDownloadModal();
  });
  return modal.querySelector('#yfxDlBody');
}

function closeDownloadModal() {
  const m = document.getElementById('yfxDownloadModal');
  if (m) m.remove();
}

function dlBtn(label, icon, color, onclick) {
  return `<button onclick="${onclick}" style="
    width:100%;padding:13px 16px;border-radius:12px;border:none;
    background:${color};color:#fff;font-size:0.9rem;font-weight:700;
    cursor:pointer;font-family:'DM Sans',sans-serif;
    display:flex;align-items:center;justify-content:center;gap:10px;
    margin-bottom:8px;transition:opacity .2s;"
    onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
    ${icon} ${label}
  </button>`;
}

function dlCancelBtn() {
  return `<button onclick="closeDownloadModal()" style="
    width:100%;padding:11px;border-radius:12px;
    background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
    color:rgba(255,255,255,0.7);font-size:0.85rem;font-weight:600;
    cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:4px;">
    ✕ Cancel
  </button>`;
}

function showDlError(body, msg) {
  body.innerHTML = `
    <div style="text-align:center;padding:1rem 0 0.5rem;">
      <div style="font-size:2rem;margin-bottom:10px;">⚠️</div>
      <div style="color:#ff4757;font-weight:600;margin-bottom:1.2rem;">${msg}</div>
    </div>
    ${dlCancelBtn()}`;
}

function showDlLoading(body, msg) {
  body.innerHTML = `
    <div style="text-align:center;padding:1.5rem 0;">
      <div style="font-size:2rem;margin-bottom:10px;animation:spin 1s linear infinite;display:inline-block;">⏳</div>
      <div style="color:rgba(255,255,255,0.7);font-size:0.9rem;">${msg}</div>
    </div>
    ${dlCancelBtn()}`;
}

// ── Direct download trigger ──────────────────────────────────
function triggerDirectDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Open download in new tab (fallback for streaming) ────────
function openDownloadTab(url) {
  window._youflexTrustedOpen = true;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ============================================================
// TRAILER DOWNLOAD
// ============================================================
window.downloadTrailer = async function(videoId, title) {
  if (!videoId) return;
  const body = createDownloadModal(title || 'Trailer');

  // Build download URL through our backend (yt-dlp)
  const dlUrl = `${API_BASE_DL}/download/trailer/${videoId}?title=${encodeURIComponent(title || 'trailer')}`;
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Check if backend download is available
  showDlLoading(body, 'Checking download options…');

  let backendAvailable = false;
  try {
    const statusRes = await fetch(`${API_BASE_DL}/download/status`, { signal: AbortSignal.timeout(5000) });
    const status = await statusRes.json();
    backendAvailable = !!(status?.data?.ytdlCore || status?.data?.ytDlp);
  } catch (_) {}

  const safeTitle = (title || 'trailer').replace(/[^a-zA-Z0-9 ]/g, '').trim();

  body.innerHTML = `
    <div style="color:rgba(255,255,255,0.6);font-size:0.8rem;margin-bottom:1rem;">
      Choose how to download this trailer:
    </div>
    ${backendAvailable ? dlBtn(
      'Download via Server (MP4)',
      '⬇️',
      'linear-gradient(135deg,#ff2a54,#ff527b)',
      `closeDownloadModal();triggerDirectDownload('${dlUrl}','${safeTitle}_trailer.mp4')`
    ) : ''}
    ${dlBtn(
      'Download on Y2Mate',
      '🎬',
      '#e52d27',
      `closeDownloadModal();openDownloadTab('https://www.y2mate.com/youtube/${videoId}')`
    )}
    ${dlBtn(
      'Download on SaveFrom',
      '💾',
      '#1a73e8',
      `closeDownloadModal();openDownloadTab('https://en.savefrom.net/1-youtube-video-downloader/?url=https://youtu.be/${videoId}')`
    )}
    ${dlBtn(
      'Open on YouTube',
      '▶️',
      '#282828',
      `closeDownloadModal();openDownloadTab('${ytUrl}')`
    )}
    ${dlCancelBtn()}`;
};

// ============================================================
// MOVIE DOWNLOAD
// ============================================================
window.downloadMovie = async function(tmdbId, title) {
  if (!tmdbId) return;
  const body = createDownloadModal(title || 'Movie');

  showDlLoading(body, 'Finding download sources…');

  // Fetch TMDB details to get IMDB id and get quality options
  let imdbId = null, movieTitle = title, year = '';
  try {
    const res = await fetch(`${API_BASE_DL}/details/movie/${tmdbId}`);
    const data = await res.json();
    if (data.success && data.data) {
      movieTitle = data.data.title || title;
      year = (data.data.release_date || '').split('-')[0] || '';
      imdbId = data.data.imdb_id || null;
    }
  } catch (_) {}

  const safeTitle = encodeURIComponent(movieTitle);
  const searchQuery = encodeURIComponent(`${movieTitle} ${year} full movie`);

  // Build source options
  const sources = [];

  // 1. Direct server torrent download (if WebTorrent available)
  sources.push({
    label: '⬇️ Download (720p)',
    color: 'linear-gradient(135deg,#ff2a54,#ff527b)',
    action: `serverDownload('movie','${tmdbId}','${movieTitle}','720p')`
  });

  sources.push({
    label: '⬇️ Download (1080p)',
    color: 'linear-gradient(135deg,#e01e43,#c0143a)',
    action: `serverDownload('movie','${tmdbId}','${movieTitle}','1080p')`
  });

  // 2. YIFY / YTS direct
  sources.push({
    label: '🎬 Browse on YTS (YIFY)',
    color: '#1e3a5f',
    action: `closeDownloadModal();openDownloadTab('https://yts.mx/movies/${movieTitle.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${year}')`
  });

  // 3. Archive.org search
  sources.push({
    label: '📚 Search Internet Archive',
    color: '#333',
    action: `closeDownloadModal();openDownloadTab('https://archive.org/search?query=${safeTitle}+movie&and%5B%5D=mediatype%3A%22movies%22')`
  });

  body.innerHTML = `
    <div style="color:rgba(255,255,255,0.55);font-size:0.78rem;margin-bottom:1rem;
      background:rgba(255,165,0,0.1);border:1px solid rgba(255,165,0,0.25);
      border-radius:8px;padding:8px 12px;">
      ⚠️ Server downloads require seeding peers. If it stalls, use the browse options.
    </div>
    ${sources.map(s => dlBtn(s.label, '', s.color, s.action)).join('')}
    ${dlCancelBtn()}`;
};

// ── Server-side torrent download ─────────────────────────────
window.serverDownload = async function(type, tmdbId, title, quality) {
  const body = document.querySelector('#yfxDownloadModal #yfxDlBody');
  if (!body) return;

  showDlLoading(body, `Searching for ${quality} torrent… This may take 30s.`);

  const qs = type === 'movie'
    ? `quality=${quality}&title=${encodeURIComponent(title)}`
    : `season=${window._dlSeason||1}&episode=${window._dlEpisode||1}&title=${encodeURIComponent(title)}`;

  const url = `${API_BASE_DL}/download/${type}/${tmdbId}?${qs}`;

  try {
    // Start the download — backend streams the torrent
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Server error' }));
      showDlError(body, err.error || 'Download failed. Try browsing YTS instead.');
      return;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      const err = await res.json();
      showDlError(body, err.error || 'No torrent found for this title.');
      return;
    }

    // Stream to file
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const safeFilename = (title || 'movie').replace(/[^a-zA-Z0-9 ]/g, '').replace(/ +/g, '_') + '.mp4';
    triggerDirectDownload(blobUrl, safeFilename);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

    closeDownloadModal();
  } catch (err) {
    if (err.name === 'AbortError') {
      showDlError(body, 'Download timed out. The server is still seeding — try YTS instead.');
    } else {
      showDlError(body, 'Connection failed. Use the YTS browse option.');
    }
  }
};

// ============================================================
// TV EPISODE DOWNLOAD
// ============================================================
window.downloadEpisode = async function(tmdbId, title, season, episode) {
  if (!tmdbId) return;
  const epLabel = `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
  const body = createDownloadModal(`${title || 'Show'} — ${epLabel}`);

  window._dlSeason = season;
  window._dlEpisode = episode;

  showDlLoading(body, 'Finding episode sources…');

  let showTitle = title, year = '';
  try {
    const res = await fetch(`${API_BASE_DL}/details/tv/${tmdbId}`);
    const data = await res.json();
    if (data.success && data.data) {
      showTitle = data.data.name || title;
      year = (data.data.first_air_date || '').split('-')[0] || '';
    }
  } catch (_) {}

  const s = String(season).padStart(2,'0');
  const e = String(episode).padStart(2,'0');
  const searchQuery = encodeURIComponent(`${showTitle} S${s}E${e}`);

  body.innerHTML = `
    <div style="color:rgba(255,255,255,0.55);font-size:0.78rem;margin-bottom:1rem;
      background:rgba(255,165,0,0.1);border:1px solid rgba(255,165,0,0.25);
      border-radius:8px;padding:8px 12px;">
      ⚠️ Server downloads require active peers. EZTV is the most reliable source for TV.
    </div>
    ${dlBtn(
      `⬇️ Server Download (${epLabel})`,
      '', 'linear-gradient(135deg,#ff2a54,#ff527b)',
      `serverDownload('tv','${tmdbId}','${showTitle}')`
    )}
    ${dlBtn(
      '📺 Browse on EZTV',
      '', '#1a5276',
      `closeDownloadModal();openDownloadTab('https://eztv.re/search/${encodeURIComponent(showTitle)}')`
    )}
    ${dlBtn(
      '🔍 Search on The Pirate Bay',
      '', '#007a3d',
      `closeDownloadModal();openDownloadTab('https://thepiratebay.org/search.php?q=${searchQuery}&cat=205')`
    )}
    ${dlBtn(
      '🗂️ Search Internet Archive',
      '', '#333',
      `closeDownloadModal();openDownloadTab('https://archive.org/search?query=${searchQuery}')`
    )}
    ${dlCancelBtn()}`;
};

// ============================================================
// EXPOSE HELPERS
// ============================================================
Object.assign(window, {
  closeDownloadModal,
  triggerDirectDownload,
  openDownloadTab,
  serverDownload,
});

console.log('✅ YOUFLEX Download Manager v4.0 loaded');
