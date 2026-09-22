// ============================================================
// YOUFLEX DOWNLOAD MANAGER — with quality picker
// ============================================================

const API_BASE_DL = 'https://youflex-server-production.up.railway.app/api';

// ── Inject styles ─────────────────────────────────────────────
const _dlStyle = document.createElement('style');
_dlStyle.textContent = `
#dlQualityModal{position:fixed;inset:0;background:rgba(0,0,0,0.88);backdrop-filter:blur(10px);z-index:99999;display:none;align-items:center;justify-content:center;padding:1.5rem}
#dlQualityModal.show{display:flex}
#dlQualityPanel{background:#0d111a;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:1.8rem;width:100%;max-width:380px;box-shadow:0 24px 80px rgba(0,0,0,0.8)}
#dlQualityPanel h3{font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:1px;color:#fff;margin-bottom:0.3rem;display:flex;align-items:center;gap:10px}
#dlQualityPanel h3 i{color:#ff2a54}
#dlQualitySubtitle{color:#8e9bb0;font-size:0.8rem;margin-bottom:1.2rem}
#dlQualityList{display:flex;flex-direction:column;gap:8px;margin-bottom:1.2rem}
.dl-quality-btn{width:100%;padding:11px 16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#fff;font-size:0.88rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:.2s;font-family:'DM Sans',sans-serif}
.dl-quality-btn:hover{background:rgba(255,42,84,0.15);border-color:rgba(255,42,84,0.4)}
.dl-quality-btn.active{background:rgba(255,42,84,0.2);border-color:#ff2a54}
.dl-quality-btn .ql-badge{background:rgba(255,42,84,0.2);color:#ff2a54;font-size:0.65rem;font-weight:700;padding:2px 8px;border-radius:10px}
#dlQualityCancel{width:100%;padding:10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:#8e9bb0;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:'DM Sans',sans-serif;transition:.2s}
#dlQualityCancel:hover{background:rgba(255,255,255,0.1);color:#fff}
#dlQualityLoading{text-align:center;padding:1.5rem 0;color:#8e9bb0;font-size:0.85rem;display:none}
#dlQualityLoading i{display:block;font-size:1.8rem;color:#ff2a54;margin-bottom:8px}
#dlToast{position:fixed;bottom:calc(var(--bottom-nav-total,64px) + 20px);left:50%;transform:translateX(-50%) translateY(20px);color:#fff;padding:11px 22px;border-radius:30px;font-size:0.84rem;font-weight:600;z-index:99999;backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.12);box-shadow:0 4px 24px rgba(0,0,0,0.5);display:flex;align-items:center;gap:10px;white-space:nowrap;font-family:'DM Sans',sans-serif;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none}
#dlToast.show{opacity:1;transform:translateX(-50%) translateY(0)}
`;
document.head.appendChild(_dlStyle);

// ── Inject quality modal HTML ─────────────────────────────────
const _dlModal = document.createElement('div');
_dlModal.id = 'dlQualityModal';
_dlModal.innerHTML = `
  <div id="dlQualityPanel">
    <h3><i class="fa-solid fa-download"></i> Download</h3>
    <div id="dlQualitySubtitle">Select quality</div>
    <div id="dlQualityLoading"><i class="fa-solid fa-spinner fa-spin"></i> Fetching available qualities…</div>
    <div id="dlQualityList"></div>
    <button id="dlQualityCancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
  </div>
`;
document.body.appendChild(_dlModal);
document.getElementById('dlQualityCancel').addEventListener('click', closeDlModal);
_dlModal.addEventListener('click', e => { if (e.target === _dlModal) closeDlModal(); });

function closeDlModal() { _dlModal.classList.remove('show'); }

// ── Toast ─────────────────────────────────────────────────────
function showDownloadToast(msg, type = 'info') {
  let toast = document.getElementById('dlToast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'dlToast'; document.body.appendChild(toast); }
  const bg = type === 'error' ? 'rgba(255,42,84,0.95)' : type === 'success' ? 'rgba(34,197,94,0.95)' : 'rgba(10,12,18,0.95)';
  const icon = type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-download';
  toast.style.background = bg;
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> ${msg}`;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Sanitize filename ─────────────────────────────────────────
function sanitizeFilename(str) {
  return (str || 'video').replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

// ── Trigger browser download via hidden anchor ────────────────
function triggerBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download.mp4';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 1000);
}

// ── Check server capability ───────────────────────────────────
let _dlCapable = null;
async function checkDownloadCapability() {
  if (_dlCapable !== null) return _dlCapable;
  try {
    const res = await fetch(`${API_BASE_DL}/download/status`);
    const data = await res.json();
    _dlCapable = data?.data || { ytDlp: false, ytdlCore: false, webTorrent: false };
  } catch (_) {
    _dlCapable = { ytDlp: false, ytdlCore: false, webTorrent: false };
  }
  return _dlCapable;
}

// ── Show quality picker modal ─────────────────────────────────
async function showQualityPicker({ tmdbId, type, title, season, episode }) {
  const list     = document.getElementById('dlQualityList');
  const loading  = document.getElementById('dlQualityLoading');
  const subtitle = document.getElementById('dlQualitySubtitle');

  list.innerHTML = '';
  loading.style.display = 'block';
  subtitle.textContent = title || 'Select quality';
  _dlModal.classList.add('show');

  const cap = await checkDownloadCapability();
  if (!cap.webTorrent && !cap.ytDlp) {
    loading.style.display = 'none';
    list.innerHTML = `<div style="color:#ff2a54;text-align:center;padding:1rem;font-size:0.85rem;"><i class="fa-solid fa-triangle-exclamation"></i> Download not available on this server.</div>`;
    return;
  }

  loading.style.display = 'none';

  const qualities = [
    { label: '1080p', value: '1080p' },
    { label: '720p',  value: '720p' },
    { label: '480p',  value: '480p' },
    { label: 'Best Available', value: 'best' },
  ];

  list.innerHTML = qualities.map((q, i) => `
    <button class="dl-quality-btn ${i === 0 ? 'active' : ''}" data-quality="${q.value}">
      <span>${q.label}</span>
      ${i === 0 ? '<span class="ql-badge">Best</span>' : ''}
    </button>`
  ).join('');

  list.querySelectorAll('.dl-quality-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      list.querySelectorAll('.dl-quality-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const quality = btn.dataset.quality;
      closeDlModal();

      const episodeLabel = type === 'tv'
        ? `_S${String(season||1).padStart(2,'0')}E${String(episode||1).padStart(2,'0')}`
        : '';
      const filename = sanitizeFilename((title || 'video') + episodeLabel) + '.mp4';
      const qs = new URLSearchParams({ quality, title: title || 'video', season: season || 1, episode: episode || 1 });
      const url = `${API_BASE_DL}/download/${type}/${tmdbId}?${qs}`;

      showDownloadToast(`Starting download${quality !== 'best' ? ` (${quality})` : ''}…`);
      triggerBrowserDownload(url, filename);
    });
  });
}

// ── MOVIE DOWNLOAD ────────────────────────────────────────────
window.downloadMovie = async function (tmdbId, title) {
  await showQualityPicker({ tmdbId, type: 'movie', title });
};

// ── TV EPISODE DOWNLOAD ───────────────────────────────────────
window.downloadEpisode = async function (tmdbId, title, season, episode) {
  await showQualityPicker({ tmdbId, type: 'tv', title, season, episode });
};

// ── TRAILER DOWNLOAD ──────────────────────────────────────────
window.downloadTrailer = async function (videoId, title) {
  if (!videoId) { showDownloadToast('No trailer to download', 'error'); return; }
  const cap = await checkDownloadCapability();
  if (!cap.trailerDownload && !cap.ytdlCore && !cap.ytDlp) {
    showDownloadToast('Trailer download not available', 'error');
    return;
  }
  const filename = sanitizeFilename(title || 'trailer') + '_trailer.mp4';
  const url = `${API_BASE_DL}/download/trailer/${videoId}?title=${encodeURIComponent(title || 'trailer')}`;
  showDownloadToast('Starting trailer download…');
  triggerBrowserDownload(url, filename);
};

// ── Pre-check capability on load ─────────────────────────────
checkDownloadCapability();
