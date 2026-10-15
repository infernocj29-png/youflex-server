// ============================================================
// YOUFLEX BACKEND v3.6 — Complete Edition
// Changes vs v3.2:
//  • FIX  /api/episodes/:tvId/:season now returns { data:{ episodes, ... } }
//         (the frontend reads `data`, so episodes always showed as "not found")
//  • FIX  /api/embed/* now return { embedUrl, allSources:[{label,name,url}] }
//         (frontend expects label/embedUrl/allSources; dead hosts removed)
//  • NEW  /api/logo/:type/:id          – stylised title-logo artwork (TMDB)
//  • NEW  /api/youtube/video/:id       – views / likes / channel for trailers
//  • FIX  trailer route also returns `name`
//  • SEC  API keys are read ONLY from environment variables
//  • SEC  server.js / package.json / .env / bin are no longer publicly served
//  v3.6: Clips API (/api/clips/*), logo prefetch on /api/trending (+ images on /details) → faster title branding
//  v3.5: TMDB cache, rate limits, optional gzip/helmet/Sentry, accounts + cloud sync, client error log
//  v3.4:
//  • Serves index.html + assets itself AND works for the Netlify site (CORS incl. previews)
//  • Trailers: season-aware, verified playable (oEmbed), correct-title YouTube fallback, cached
// ============================================================
'use strict';

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
// Optional packages — server runs fine without them:  npm i compression helmet @sentry/node
const opt = name => { try { return require(name); } catch (_) { return null; } };
const compression = opt('compression');
const helmet      = opt('helmet');
const Sentry      = opt('@sentry/node');

const app  = express();
const PORT = process.env.PORT || 10000;
app.set('trust proxy', 1);   // real client IP behind Railway/Render (needed for rate limits)

// ⚠️ Set these in your host's Environment Variables (Railway / Render).
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const TMDB_BASE       = 'https://api.themoviedb.org/3';

if (Sentry && process.env.SENTRY_DSN) { try { Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 }); console.log('✅ Sentry enabled'); } catch (e) { console.warn('Sentry init failed:', e.message); } }
if (!TMDB_API_KEY)    console.error('❌ TMDB_API_KEY is not set — TMDB requests will fail.');
if (!YOUTUBE_API_KEY) console.warn('⚠️  YOUTUBE_API_KEY is not set — YouTube fallback/stats disabled.');

// ── Auto-install yt-dlp if missing ───────────────────────────
(async () => {
    const ytDlpPath = path.join(__dirname, 'bin/yt-dlp');
    if (!fs.existsSync(ytDlpPath)) {
        console.log('📥 Installing yt-dlp...');
        try {
            fs.mkdirSync(path.join(__dirname, 'bin'), { recursive: true });
            execSync(
                `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${ytDlpPath} && chmod +x ${ytDlpPath}`,
                { stdio: 'inherit', timeout: 60000 }
            );
            console.log('✅ yt-dlp installed successfully');
        } catch (err) {
            console.error('❌ Failed to install yt-dlp:', err.message);
        }
    }
})();

// ── Security headers + gzip (optional packages) ───────────────
if (helmet) app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, frameguard: false }));
if (compression) app.use(compression());

// ── tiny in-memory rate limiter (no dependency) ───────────────
function rateLimit({ windowMs, max, message }) {
    const hits = new Map();
    setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
    return (req, res, next) => {
        const now = Date.now();
        let h = hits.get(req.ip);
        if (!h || h.reset < now) { h = { count: 0, reset: now + windowMs }; hits.set(req.ip, h); }
        h.count++;
        res.setHeader('RateLimit-Remaining', Math.max(0, max - h.count));
        if (h.count > max) {
            res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
            return res.status(429).json({ success: false, error: message || 'Too many requests, slow down.' });
        }
        next();
    };
}

// ── CORS: Netlify site + this server + local dev ─────────────
// Extra origins (custom domain etc.) → env EXTRA_ORIGINS="https://a.com,https://b.com"
const EXTRA_ORIGINS = (process.env.EXTRA_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
const FIXED_ORIGINS = new Set(['https://youflex.netlify.app', ...EXTRA_ORIGINS]);
function isAllowedOrigin(origin) {
    if (!origin) return true;                          // same-origin / curl / server-to-server
    if (FIXED_ORIGINS.has(origin)) return true;
    try {
        const { hostname } = new URL(origin);
        if (hostname === 'localhost' || hostname === '127.0.0.1') return true;           // any local port
        if (hostname === 'youflex.netlify.app' || /--youflex\.netlify\.app$/.test(hostname)) return true; // Netlify previews
        if (hostname.endsWith('.up.railway.app') || hostname.endsWith('.onrender.com')) return true;      // this server's own host
    } catch (_) {}
    return false;
}
app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
    maxAge: 86400,
}));
app.use(express.json({ limit: '1mb' }));

// Rate limits + browser caching headers for the API
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));
app.use('/api/auth',     rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many sign-in attempts. Try again later.' }));
app.use('/api/download', rateLimit({ windowMs: 60 * 60 * 1000, max: 6,  message: 'Download limit reached. Try again later.' }));
app.use('/api/trailer',  rateLimit({ windowMs: 60 * 1000, max: 90 }));
app.use('/api/clips',    rateLimit({ windowMs: 60 * 1000, max: 150 }));
app.use('/api', (req, res, next) => {
    if (/^\/(auth|sync|download|health|client-error)/.test(req.path)) res.set('Cache-Control', 'no-store');
    else res.set('Cache-Control', 'public, max-age=120');
    next();
});

// ── Frontend hosting: this server also serves index.html + assets ──
// Never expose backend source / config through the static handler
app.use((req, res, next) => {
    if (/^\/(server\.js|package(-lock)?\.json|\.env.*|\.git.*|bin\/|data\/|node_modules\/)|\.md$/i.test(req.path)) {
        return res.status(404).end();
    }
    next();
});
function sendIndex(req, res) {
    const f = path.join(__dirname, 'index.html');
    if (!fs.existsSync(f)) return res.status(404).json({ success: false, error: 'index.html not found next to server.js' });
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(f);
}
app.get('/', sendIndex);
app.use(express.static(__dirname, {
    index: false,
    setHeaders: (res, fp) => { if (fp.endsWith('.html') || fp.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache'); },
}));

// ── TMDB helper (with in-memory cache + in-flight de-duplication) ──
const tmdbCache = new Map();
const tmdbInflight = new Map();
const TMDB_CACHE_MAX = 800;
function tmdbTtl(endpoint) {
    if (endpoint.startsWith('/search')) return 2 * 60 * 1000;
    if (endpoint.startsWith('/trending')) return 10 * 60 * 1000;
    return 15 * 60 * 1000;
}
async function tmdbFetch(endpoint, params = {}) {
    // FIX: clear 503 if the API key was never configured, so the frontend
    // shows "service unavailable" instead of a cryptic 500 error.
    if (!TMDB_API_KEY) {
        const err = new Error('TMDB_API_KEY is not configured on the server');
        err.status = 503;
        throw err;
    }
    const key = endpoint + '?' + JSON.stringify(params);
    const hit = tmdbCache.get(key);
    if (hit && Date.now() - hit.ts < hit.ttl) return hit.data;
    if (tmdbInflight.has(key)) return tmdbInflight.get(key);
    const p = axios.get(`${TMDB_BASE}${endpoint}`, {
        params: { api_key: TMDB_API_KEY, ...params },
        timeout: 10000,
    }).then(res => {
        tmdbCache.set(key, { ts: Date.now(), ttl: tmdbTtl(endpoint), data: res.data });
        if (tmdbCache.size > TMDB_CACHE_MAX) tmdbCache.delete(tmdbCache.keys().next().value);
        return res.data;
    }).finally(() => tmdbInflight.delete(key));
    tmdbInflight.set(key, p);
    return p;
}

// ── Trailer helpers ───────────────────────────────────────────
const TRAILER_EXCLUDED = ['behind the scenes', 'bts', 'clip', 'featurette', 'bloopers', 'deleted', 'making of', 'interview', 'reaction', 'review', 'recap', '#shorts', '| shorts'];
const normTitle = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const trailerCache = new Map();           // key -> { ts, data }
const TRAILER_TTL  = 6 * 60 * 60 * 1000;

// keyless check: is this video alive AND allowed to be embedded?  ok:true | false | null(unknown)
async function checkEmbeddable(videoId) {
    try {
        const r = await axios.get('https://www.youtube.com/oembed', {
            params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
            timeout: 6000, validateStatus: () => true,
        });
        if (r.status === 200 && r.data) return { ok: true, title: r.data.title, channel: r.data.author_name };
        if ([401, 403, 404].includes(r.status)) return { ok: false };
        return { ok: null };
    } catch (_) { return { ok: null }; }
}

function trailerScore(v) {
    const n = (v.name || '').toLowerCase();
    let sc = 0;
    if (v.type === 'Trailer') sc += 100;
    if (v.official) sc += 50;
    if (n.includes('official')) sc += 20;
    if (/main|final/.test(n)) sc += 5;
    if (v.iso_639_1 === 'en') sc += 10;
    sc += Math.min((v.size || 0) / 100, 15);
    return sc;
}
function rankTrailers(videos) {
    return (videos || [])
        .filter(v => v.site === 'YouTube' && v.key && (v.type === 'Trailer' || v.type === 'Teaser')
                  && !TRAILER_EXCLUDED.some(ex => (v.name || '').toLowerCase().includes(ex)))
        .sort((a, b) => trailerScore(b) - trailerScore(a) || String(b.published_at).localeCompare(String(a.published_at)));
}

// YouTube search fallback (title must match so we never play the wrong film)
async function getYouTubeCandidates(title, year) {
    if (!YOUTUBE_API_KEY) return [];
    try {
        const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                key: YOUTUBE_API_KEY,
                q: `${title} ${year || ''} official trailer`.trim(),
                part: 'snippet', type: 'video', maxResults: 10,
                videoEmbeddable: 'true', relevanceLanguage: 'en',
                // NOTE: no videoDuration filter – 'medium' (4-20min) would exclude almost every trailer
            },
            timeout: 10000,
        });
        const nt = normTitle(title);
        return (res.data?.items || []).filter(i => {
            const t = (i.snippet?.title || '').toLowerCase();
            return (t.includes('trailer') || t.includes('teaser'))
                && normTitle(t).includes(nt)
                && !TRAILER_EXCLUDED.some(ex => t.includes(ex));
        }).map(i => i.id?.videoId).filter(Boolean);
    } catch (err) {
        console.error('YouTube search error:', err.message);
        return [];
    }
}

// Find the trailer that belongs to THIS movie / show (/ season) and verify it can play
async function resolveTrailer(type, id, season) {
    const cacheKey = `${type}-${id}-${season || ''}`;
    const hit = trailerCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < TRAILER_TTL) return hit.data;

    const details = await tmdbFetch(`/${type}/${id}`);
    const title = details.title || details.name;
    const year  = (details.release_date || details.first_air_date || '').split('-')[0];
    const langs = ['en', 'null'];
    if (details.original_language && details.original_language !== 'en') langs.push(details.original_language);
    const include = langs.join(',');

    const candidates = [];
    const seen = new Set();
    const addGroup = async (endpoint) => {
        try {
            const d = await tmdbFetch(endpoint, { include_video_language: include });
            rankTrailers(d.results).forEach(v => { if (!seen.has(v.key)) { seen.add(v.key); candidates.push(v); } });
        } catch (_) {}
    };

    if (type === 'tv') {
        const seasons = (details.seasons || []).map(s => s.season_number).filter(n => n > 0);
        const wanted  = season && seasons.includes(Number(season)) ? Number(season) : null;
        if (wanted) await addGroup(`/tv/${id}/season/${wanted}/videos`);   // trailer for the season being watched
        await addGroup(`/tv/${id}/videos`);                                 // show-level trailer
        if (!candidates.length) {                                           // fall back to any season trailer
            for (const sn of [seasons[seasons.length - 1], seasons[0]].filter((v, i, a) => v != null && a.indexOf(v) === i)) {
                await addGroup(`/tv/${id}/season/${sn}/videos`);
            }
        }
    } else {
        await addGroup(`/movie/${id}/videos`);
    }

    // verify the best few candidates in parallel, keep TMDB's ranking order
    const checkList = async (list) => {
        const checks = await Promise.all(list.slice(0, 6).map(c => checkEmbeddable(c.key)));
        const idx = checks.findIndex(c => c.ok !== false);
        return idx === -1 ? null : { cand: list[idx], info: checks[idx] };
    };

    let result = null;
    const good = await checkList(candidates);
    if (good) {
        result = {
            videoId: good.cand.key,
            title: good.cand.name, name: good.info.title || good.cand.name,
            channelTitle: good.info.channel || null,
            source: 'tmdb',
        };
    } else {
        const ytIds = await getYouTubeCandidates(title, year);
        const good2 = await checkList(ytIds.map(k => ({ key: k, name: `${title} Official Trailer` })));
        if (good2) {
            result = {
                videoId: good2.cand.key,
                title: `${title} Official Trailer`, name: good2.info.title || `${title} Official Trailer`,
                channelTitle: good2.info.channel || null,
                source: 'youtube',
            };
        }
    }
    if (result) trailerCache.set(cacheKey, { ts: Date.now(), data: result });
    return result;
}

// ── yt-dlp ────────────────────────────────────────────────────
function getYtDlpPath() {
    const candidates = [path.join(__dirname, 'bin/yt-dlp'), '/opt/render/project/src/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', 'yt-dlp'];
    for (const p of candidates) {
        try { execSync(`"${p}" --version`, { stdio: 'pipe', timeout: 5000 }); return p; } catch (_) {}
    }
    return null;
}
let YT_DLP_PATH = null;
try { YT_DLP_PATH = getYtDlpPath(); console.log(YT_DLP_PATH ? `✅ yt-dlp: ${YT_DLP_PATH}` : '⚠️  yt-dlp not found'); } catch (_) {}

// ── ytdl-core ─────────────────────────────────────────────────
let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); console.log('✅ ytdl-core loaded'); } catch (_) { console.warn('⚠️  ytdl-core not found'); }

// ── WebTorrent ────────────────────────────────────────────────
let WebTorrent = null, wtClient = null;
try { WebTorrent = require('webtorrent'); console.log('✅ WebTorrent loaded'); } catch (_) { console.warn('⚠️  WebTorrent not found'); }
function getWtClient() {
    if (!wtClient && WebTorrent) { wtClient = new WebTorrent(); wtClient.on('error', err => console.error('WebTorrent:', err.message)); }
    return wtClient;
}
function safeFilename(str) { return (str||'video').replace(/[^\w\s\-().]/g,'').replace(/\s+/g,'_').slice(0,80); }

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => res.json({ success: true, service: 'YOUFLEX API', version: '3.6', timestamp: new Date().toISOString() }));

// ============================================================
// GENRES
// ============================================================
app.get('/api/genres/all', async (req, res) => {
    try {
        const [movies, tv] = await Promise.all([tmdbFetch('/genre/movie/list'), tmdbFetch('/genre/tv/list')]);
        const all = {};
        [...(movies.genres||[]), ...(tv.genres||[])].forEach(g => { all[g.id] = g.name; });
        res.json({ success: true, data: all });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/genres/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/genre/${req.params.type}/list`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// TRENDING — returns results array directly
// ============================================================
// ── title-logo helper (24h cache) ─────────────────────────────
const logoCache = new Map();
async function getLogoPath(type, id) {
    const k = `${type}-${id}`;
    const hit = logoCache.get(k);
    if (hit && Date.now() - hit.ts < 24 * 60 * 60 * 1000) return hit.path;
    try {
        const d = await tmdbFetch(`/${type}/${id}/images`, { include_image_language: 'en,null' });
        const logos = (d.logos || []).filter(l => l.file_path);
        const score = l => (l.iso_639_1 === 'en' ? 2 : (l.iso_639_1 == null ? 1 : 0)) * 1000 + (l.vote_average || 0);
        logos.sort((a, b) => score(b) - score(a));
        const path = logos[0]?.file_path || null;
        logoCache.set(k, { ts: Date.now(), path });
        return path;
    } catch (_) { return undefined; }
}

app.get('/api/trending', async (req, res) => {
    try {
        const { type = 'all', page = 1 } = req.query;
        const data = await tmdbFetch(`/trending/${type}/week`, { page });
        const results = data.results || [];
        const titles = results.filter(r => r.media_type !== 'person');
        const typeOf = r => r.media_type || (type === 'tv' ? 'tv' : 'movie');
        // top titles get their branding logo inline (max 1.5s wait); the rest are warmed in the background
        await Promise.race([
            Promise.all(titles.slice(0, 8).map(async r => { const p = await getLogoPath(typeOf(r), r.id); if (p) r.logo_path = p; })),
            new Promise(r => setTimeout(r, 1500)),
        ]);
        titles.slice(8).forEach(r => { getLogoPath(typeOf(r), r.id).then(p => { if (p) r.logo_path = p; }).catch(() => {}); });
        res.json({ success: true, data: results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/trending/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/trending/${req.params.type}/week`, { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// CONTENT
// ============================================================
app.get('/api/content/trending', async (req, res) => {
    try {
        const data = await tmdbFetch('/trending/all/week', { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/content/popular', async (req, res) => {
    try {
        const { type = 'movie', page = 1 } = req.query;
        const data = await tmdbFetch(`/${type}/popular`, { page });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/content/top-rated', async (req, res) => {
    try {
        const { type = 'movie', page = 1 } = req.query;
        const data = await tmdbFetch(`/${type}/top_rated`, { page });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/content/upcoming', async (req, res) => {
    try {
        const data = await tmdbFetch('/movie/upcoming', { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/content/anime', async (req, res) => {
    try {
        const data = await tmdbFetch('/discover/tv', {
            page: req.query.page || 1,
            with_genres: 16,
            with_keywords: '210024|287501',
            sort_by: 'popularity.desc',
            with_original_language: 'ja',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/content/animation', async (req, res) => {
    try {
        const data = await tmdbFetch('/discover/movie', { page: req.query.page || 1, with_genres: 16, sort_by: 'popularity.desc' });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// GENRE BROWSE
// ============================================================
app.get('/api/genre/:genreId', async (req, res) => {
    try {
        const { type = 'movie', page = 1, sort = 'popularity.desc' } = req.query;
        const data = await tmdbFetch(`/discover/${type}`, { page, with_genres: req.params.genreId, sort_by: sort });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// SEARCH
// ============================================================
app.get('/api/search', async (req, res) => {
    try {
        const searchQuery = req.query.query || req.query.q;
        if (!searchQuery) return res.status(400).json({ success: false, error: 'Query required' });
        const data = await tmdbFetch('/search/multi', { query: searchQuery, page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// DETAILS
// ============================================================
app.get('/api/details/:type/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/${req.params.id}`, {
            append_to_response: 'credits,videos,similar,recommendations,external_ids,watch/providers,images',
            include_image_language: 'en,null',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/movie/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/movie/${req.params.id}`, {
            append_to_response: 'credits,videos,similar,recommendations,external_ids,watch/providers',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tv/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/tv/${req.params.id}`, {
            append_to_response: 'credits,videos,similar,recommendations,external_ids,watch/providers',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// TITLE LOGO  (stylised movie-name artwork)   — NEW
// Returns { logo_path, logos:[...] }; best English logo first.
// ============================================================
app.get('/api/logo/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
        const d = await tmdbFetch(`/${type}/${id}/images`, { include_image_language: 'en,null' });
        const logos = (d.logos || []).filter(l => l.file_path);
        const score = l => (l.iso_639_1 === 'en' ? 2 : (l.iso_639_1 == null ? 1 : 0)) * 1000 + (l.vote_average || 0);
        logos.sort((a, b) => score(b) - score(a));
        res.set('Cache-Control', 'public, max-age=86400');
        res.json({ success: true, data: { logo_path: logos[0]?.file_path || null, logos: logos.slice(0, 5) } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// CREDITS
// ============================================================
app.get('/api/credits/:type/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/${req.params.id}/credits`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// EPISODES   — FIXED: episodes now live under `data`
// ============================================================
app.get('/api/episodes/:tvId/:season', async (req, res) => {
    try {
        const season = await tmdbFetch(`/tv/${req.params.tvId}/season/${req.params.season}`);
        const episodes = season.episodes || [];
        res.json({
            success: true,
            data: { ...season, episodes },   // frontend reads data.episodes
            episodes,                        // kept for any older client
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tv/:id/seasons', async (req, res) => {
    try {
        const data = await tmdbFetch(`/tv/${req.params.id}`);
        res.json({ success: true, data: { seasons: data.seasons || [] } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tv/:id/season/:season', async (req, res) => {
    try {
        const data = await tmdbFetch(`/tv/${req.params.id}/season/${req.params.season}`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// SIMILAR & RECOMMENDATIONS
// ============================================================
app.get('/api/similar/:type/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/${req.params.id}/similar`, { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/recommendations/enhanced/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const [recs, similar] = await Promise.all([
            tmdbFetch(`/${type}/${id}/recommendations`, { page: 1 }),
            tmdbFetch(`/${type}/${id}/similar`, { page: 1 }),
        ]);
        const combined = [...(recs.results||[]), ...(similar.results||[])];
        const unique   = combined.filter((v,i,a) => a.findIndex(t=>t.id===v.id)===i);
        res.json({ success: true, data: { results: unique.slice(0,20), recommendations: unique.slice(0,20) } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// PROVIDERS
// ============================================================
app.get('/api/providers/:type/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/${req.params.id}/watch/providers`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// PERSON
// ============================================================
app.get('/api/person/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/person/${req.params.id}`, {
            append_to_response: 'movie_credits,tv_credits,external_ids',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// DISCOVER
// ============================================================
app.get('/api/discover/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/discover/${req.params.type}`, req.query);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// POPULAR & TOP RATED (legacy)
// ============================================================
app.get('/api/popular/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/popular`, { page: req.query.page||1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/top-rated/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/top_rated`, { page: req.query.page||1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// YOUTUBE
// ============================================================
app.get('/api/trailer/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
        const result = await resolveTrailer(type, id, req.query.season);
        if (!result) return res.status(404).json({ success: false, error: 'No playable trailer found' });
        res.json({ success: true, data: result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/youtube/search', async (req, res) => {
    try {
        if (!req.query.q) return res.status(400).json({ success: false, error: 'Query required' });
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { key: YOUTUBE_API_KEY, q: req.query.q, part: 'snippet', type: 'video', maxResults: req.query.maxResults || 10, videoDuration: 'medium' },
            timeout: 10000,
        });
        res.json({ success: true, data: response.data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// NEW — stats for the trailer info bar (views / likes / channel)
app.get('/api/youtube/video/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.status(400).json({ success: false, error: 'Invalid YouTube video ID' });
        if (!YOUTUBE_API_KEY) return res.status(503).json({ success: false, error: 'YouTube API key not configured' });
        const r = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
            params: { key: YOUTUBE_API_KEY, id, part: 'snippet,statistics' },
            timeout: 10000,
        });
        const v = r.data?.items?.[0];
        if (!v) return res.status(404).json({ success: false, error: 'Video not found' });
        res.json({ success: true, data: {
            videoId: id,
            title: v.snippet?.title,
            channelTitle: v.snippet?.channelTitle,
            viewCount: v.statistics?.viewCount,
            likeCount: v.statistics?.likeCount,
        }});
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// CLIPS — official clips / teasers / featurettes from TMDB Videos (YouTube),
// every video verified as embeddable before it is ever returned.
// No full-length stream URLs are used; nothing is fabricated.
// ============================================================
const CLIP_TYPES      = ['Clip', 'Bloopers', 'Featurette', 'Teaser'];
const CLIP_TYPE_SCORE = { Clip: 100, Bloopers: 60, Featurette: 40, Teaser: 30 };
const CLIP_EXCLUDED   = ['reaction', 'review', 'recap', 'interview', '#shorts', '| shorts', 'behind the scenes', 'bts', 'explained', 'breakdown', 'top 10'];
const GENRE_LABEL = { 28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action', 10765: 'Sci-Fi', 10768: 'War' };
const categoryOf = ids => { for (const g of ids || []) if (GENRE_LABEL[g]) return GENRE_LABEL[g]; return 'Featured'; };

async function mapLimit(arr, limit, fn) {
    const out = new Array(arr.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, async () => {
        while (i < arr.length) { const k = i++; try { out[k] = await fn(arr[k], k); } catch (_) { out[k] = null; } }
    }));
    return out;
}

const clipCache = new Map(), clipInflight = new Map();
async function clipCached(key, fn, ttl = 10 * 60 * 1000) {
    const h = clipCache.get(key);
    if (h && Date.now() - h.ts < ttl) return h.data;
    if (clipInflight.has(key)) return clipInflight.get(key);
    const p = fn().then(d => {
        clipCache.set(key, { ts: Date.now(), data: d });
        if (clipCache.size > 300) clipCache.delete(clipCache.keys().next().value);
        return d;
    }).finally(() => clipInflight.delete(key));
    clipInflight.set(key, p);
    return p;
}

// embeddable check (cached 24h)
const embedOkCache = new Map();
async function embeddableInfo(videoId) {
    const h = embedOkCache.get(videoId);
    if (h && Date.now() - h.ts < 24 * 60 * 60 * 1000) return h;
    const r = await checkEmbeddable(videoId);
    const info = { ts: Date.now(), ok: r.ok !== false, title: r.title || null, channel: r.channel || null };
    embedOkCache.set(videoId, info);
    return info;
}

// durations via YouTube Data API (optional). -1 = video missing/private → drop it
const durCache = new Map();
function isoToSeconds(iso) {
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
async function loadDurations(ids) {
    if (!YOUTUBE_API_KEY) return;
    const need = ids.filter(id => !durCache.has(id));
    for (let i = 0; i < need.length; i += 50) {
        const chunk = need.slice(i, i + 50);
        try {
            const r = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
                params: { key: YOUTUBE_API_KEY, id: chunk.join(','), part: 'contentDetails' }, timeout: 10000,
            });
            const found = new Set();
            (r.data?.items || []).forEach(it => { found.add(it.id); durCache.set(it.id, isoToSeconds(it.contentDetails?.duration)); });
            chunk.forEach(id => { if (!found.has(id)) durCache.set(id, -1); });
        } catch (err) { console.error('YouTube duration error:', err.message); }
    }
}

async function titleClipCandidates(type, id) {
    const d = await tmdbFetch(`/${type}/${id}/videos`, { include_video_language: 'en,null' });
    return (d.results || [])
        .filter(v => v.site === 'YouTube' && v.key && CLIP_TYPES.includes(v.type) && !CLIP_EXCLUDED.some(x => (v.name || '').toLowerCase().includes(x)))
        .map(v => ({ v, score: CLIP_TYPE_SCORE[v.type] + (v.official ? 20 : 0) + Math.min((v.size || 0) / 100, 12) }))
        .sort((a, b) => b.score - a.score || String(b.v.published_at).localeCompare(String(a.v.published_at)))
        .map(x => x.v);
}
const typeOfTitle = t => t.media_type === 'tv' ? 'tv' : t.media_type === 'movie' ? 'movie' : (t.title ? 'movie' : 'tv');

async function buildClips(titles, { perTitle = 2, limit = 24 } = {}) {
    const lists = await mapLimit(titles, 8, async t => {
        const type = typeOfTitle(t);
        const vids = await titleClipCandidates(type, t.id);
        const picked = []; let nonClip = 0;
        for (const v of vids) {
            if (picked.length >= perTitle) break;
            if (v.type !== 'Clip') { if (nonClip >= 1) continue; nonClip++; }
            picked.push({ v, t, type });
        }
        return picked;
    });
    // interleave: first clip of every title, then second clips …
    const flat = []; const seen = new Set();
    for (let r = 0; r < perTitle; r++) for (const l of lists) { const x = l && l[r]; if (x && !seen.has(x.v.key)) { seen.add(x.v.key); flat.push(x); } }
    const pool = flat.slice(0, Math.ceil(limit * 1.5));
    const checks = await mapLimit(pool, 8, async x => embeddableInfo(x.v.key));
    const ok = pool.filter((x, i) => checks[i] && checks[i].ok);
    await loadDurations(ok.map(x => x.v.key));
    const items = [];
    for (const { v, t, type } of ok) {
        const dur = durCache.get(v.key);
        if (dur === -1 || dur > 900) continue;                       // missing/private, or too long to be a "clip"
        items.push({
            id: v.key, videoId: v.key, name: v.name, kind: v.type,
            tmdbId: t.id, mediaType: type, title: t.title || t.name,
            overview: t.overview || '', poster_path: t.poster_path, backdrop_path: t.backdrop_path,
            genre_ids: t.genre_ids || (t.genres || []).map(g => g.id) || [],
            category: categoryOf(t.genre_ids || (t.genres || []).map(g => g.id)),
            vote_average: t.vote_average || 0,
            year: (t.release_date || t.first_air_date || '').slice(0, 4),
            duration: dur > 0 ? dur : null,
            thumb: `https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`,
            published: v.published_at,
        });
        if (items.length >= limit) break;
    }
    return items;
}

// ── section sources ───────────────────────────────────────────
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const tagType = (d, type) => (d.results || []).map(x => ({ ...x, media_type: type }));
async function mixedTitles(page, movieEP, moviePrm, tvEP, tvPrm) {
    const [m, t] = await Promise.all([
        movieEP ? tmdbFetch(movieEP, { ...moviePrm, page }) : { results: [] },
        tvEP ? tmdbFetch(tvEP, { ...tvPrm, page }) : { results: [] },
    ]);
    const A = tagType(m, 'movie'), B = tagType(t, 'tv'), out = [];
    for (let i = 0; i < Math.max(A.length, B.length); i++) { if (A[i]) out.push(A[i]); if (B[i]) out.push(B[i]); }
    return out;
}
const POP = { sort_by: 'popularity.desc' };
const CLIP_SECTIONS = {
    trending:    { label: '🔥 Trending Clips',          titles: async p => (await tmdbFetch('/trending/all/week', { page: p })).results.filter(x => x.media_type !== 'person') },
    action:      { label: '💥 Action & Fight Scenes',   titles: p => mixedTitles(p, '/discover/movie', { ...POP, with_genres: 28, 'vote_count.gte': 200 }, '/discover/tv', { ...POP, with_genres: 10759, 'vote_count.gte': 100 }) },
    comedy:      { label: '😂 Comedy Moments',          titles: p => mixedTitles(p, '/discover/movie', { ...POP, with_genres: 35, 'vote_count.gte': 200 }, '/discover/tv', { ...POP, with_genres: 35, 'vote_count.gte': 100 }) },
    emotional:   { label: '❤️ Emotional Scenes',        titles: p => mixedTitles(p, '/discover/movie', { ...POP, with_genres: '18|10749', 'vote_average.gte': 7.3, 'vote_count.gte': 500 }, '/discover/tv', { ...POP, with_genres: 18, 'vote_average.gte': 7.8, 'vote_count.gte': 200 }) },
    shocking:    { label: '😱 Shocking Moments',        titles: p => mixedTitles(p, '/discover/movie', { ...POP, with_genres: '53|27|9648', 'vote_count.gte': 300 }, '/discover/tv', { ...POP, with_genres: '9648|80', 'vote_count.gte': 150 }) },
    mindblowing: { label: '🧠 Mind-Blowing Scenes',     titles: p => mixedTitles(p, '/discover/movie', { ...POP, with_genres: '878|14', 'vote_average.gte': 7, 'vote_count.gte': 500 }, '/discover/tv', { ...POP, with_genres: 10765, 'vote_count.gte': 200 }) },
    tv:          { label: '📺 Popular TV Show Clips',   titles: p => mixedTitles(p, null, {}, '/tv/popular', {}) },
    movies:      { label: '🎬 Movie Highlights',        titles: p => mixedTitles(p, '/movie/popular', {}, null, {}) },
    recent:      { label: '🆕 Recently Added Clips',    titles: p => mixedTitles(p, '/discover/movie', { sort_by: 'primary_release_date.desc', 'primary_release_date.gte': daysAgo(150), 'primary_release_date.lte': daysAgo(0), 'vote_count.gte': 20 }, '/discover/tv', { sort_by: 'first_air_date.desc', 'first_air_date.gte': daysAgo(150), 'first_air_date.lte': daysAgo(0), 'vote_count.gte': 5 }) },
};
const TV_GENRE_MAP = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };

app.get('/api/clips/section/:key', async (req, res) => {
    try {
        const def = CLIP_SECTIONS[req.params.key];
        if (!def) return res.status(404).json({ success: false, error: 'Unknown section' });
        const page = Math.max(1, Math.min(8, parseInt(req.query.page) || 1));
        const data = await clipCached(`sec:${req.params.key}:${page}`, async () => {
            const titles = await def.titles(page);
            const items = await buildClips(titles.slice(0, 20), { perTitle: 2, limit: 24 });
            return { key: req.params.key, label: def.label, page, items, hasMore: page < 8 };
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/clips/featured', async (req, res) => {
    try {
        const data = await clipCached('featured', async () => {
            const d = await tmdbFetch('/trending/all/week', { page: 1 });
            const titles = (d.results || []).filter(x => x.media_type !== 'person' && x.backdrop_path).slice(0, 12);
            const items = await buildClips(titles, { perTitle: 1, limit: 5 });
            return { items };
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// personalised row: /api/clips/discover?genres=28,35
app.get('/api/clips/discover', async (req, res) => {
    try {
        const ids = String(req.query.genres || '').split(',').map(x => parseInt(x)).filter(Boolean).slice(0, 3);
        if (!ids.length) return res.status(400).json({ success: false, error: 'genres required' });
        const page = Math.max(1, Math.min(5, parseInt(req.query.page) || 1));
        const data = await clipCached(`disc:${ids.join('|')}:${page}`, async () => {
            const tvIds = [...new Set(ids.map(g => TV_GENRE_MAP[g] || g))];
            const titles = await mixedTitles(page, '/discover/movie', { ...POP, with_genres: ids.join('|'), 'vote_count.gte': 300 }, '/discover/tv', { ...POP, with_genres: tvIds.join('|'), 'vote_count.gte': 100 });
            const items = await buildClips(titles.slice(0, 20), { perTitle: 2, limit: 20 });
            return { key: 'foryou', label: '✨ Picked For You', page, items, hasMore: false };
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/clips/title/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
        const data = await clipCached(`title:${type}:${id}`, async () => {
            const d = await tmdbFetch(`/${type}/${id}`);
            const items = await buildClips([{ ...d, media_type: type }], { perTitle: 8, limit: 12 });
            return { items };
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// "More like this": other clips from the same title + clips from similar titles
app.get('/api/clips/similar/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
        const data = await clipCached(`sim:${type}:${id}`, async () => {
            const [d, rec, sim] = await Promise.all([
                tmdbFetch(`/${type}/${id}`),
                tmdbFetch(`/${type}/${id}/recommendations`, { page: 1 }).catch(() => ({ results: [] })),
                tmdbFetch(`/${type}/${id}/similar`, { page: 1 }).catch(() => ({ results: [] })),
            ]);
            const seen = new Set([Number(id)]);
            const related = [...(rec.results || []), ...(sim.results || [])]
                .filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; })
                .slice(0, 12).map(x => ({ ...x, media_type: type }));
            const [same, similar] = await Promise.all([
                buildClips([{ ...d, media_type: type }], { perTitle: 8, limit: 10 }),
                buildClips(related, { perTitle: 1, limit: 14 }),
            ]);
            return { same, similar };
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/clips/search', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim().slice(0, 80);
        if (q.length < 2) return res.status(400).json({ success: false, error: 'Query too short' });
        const data = await clipCached(`search:${q.toLowerCase()}`, async () => {
            const d = await tmdbFetch('/search/multi', { query: q, page: 1 });
            const titles = (d.results || []).filter(x => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 10);
            const items = await buildClips(titles, { perTitle: 3, limit: 30 });
            return { key: 'search', label: `Results for “${q}”`, items, hasMore: false };
        }, 5 * 60 * 1000);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// confirm a single clip can still be embedded (used right before playback / deep links)
app.get('/api/clips/validate/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ success: false, error: 'Invalid video id' });
        const info = await embeddableInfo(videoId);
        res.json({ success: true, data: { ok: info.ok, title: info.title, channel: info.channel } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// EMBED SOURCES   — vidsrc.me ONLY
// All other sources removed at the user's request.
// ============================================================
const EMBED_SOURCES = [
    { name: 'vidsrc.me', movie: id => `https://vidsrc.me/embed/movie?tmdb=${id}`,
                          tv: (id,s,e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
];

function embedPayload(list) {
    const sources = list.map(s => ({ name: s.name, label: s.name, url: s.url }));
    return { embedUrl: sources[0]?.url || null, sources, allSources: sources };
}

app.get('/api/embed/movie/:tmdbId', (req, res) => {
    const { tmdbId } = req.params;
    res.json({ success: true, data: embedPayload(EMBED_SOURCES.map(s => ({ name: s.name, url: s.movie(tmdbId) }))) });
});

app.get('/api/embed/tv/:tmdbId/:season/:episode', (req, res) => {
    const { tmdbId, season, episode } = req.params;
    res.json({ success: true, data: embedPayload(EMBED_SOURCES.map(s => ({ name: s.name, url: s.tv(tmdbId, season, episode) }))) });
});

app.get('/api/embed/sources/:type/:tmdbId', (req, res) => {
    const { type, tmdbId } = req.params;
    const { season = 1, episode = 1 } = req.query;
    res.json({ success: true, data: embedPayload(EMBED_SOURCES.map(s => ({
        name: s.name,
        url: type === 'tv' ? s.tv(tmdbId, season, episode) : s.movie(tmdbId),
    }))) });
});

// ============================================================
// DOWNLOAD
// ============================================================
async function searchYIFY(tmdbId, quality = '720p') {
    try {
        const details = await tmdbFetch(`/movie/${tmdbId}`);
        const title   = details.title;
        const year    = details.release_date?.split('-')[0];
        if (!title) return null;
        console.log(`🔍 YIFY: ${title} (${year})`);
        let movies = [];
        for (const url of [
            `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=5`,
            `https://yts.lt/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=5`,
        ]) {
            try { const r = await axios.get(url, { timeout: 8000 }); movies = r.data?.data?.movies||[]; if (movies.length) break; } catch (_) {}
        }
        if (!movies.length) return null;
        const match    = movies.find(m => String(m.year)===String(year) || m.title.toLowerCase()===title.toLowerCase()) || movies[0];
        const torrents = match.torrents || [];
        const torrent  = torrents.find(t => t.quality===quality) || torrents.find(t => t.quality==='720p') || torrents[0];
        if (!torrent) return null;
        const tr = ['udp://open.demonii.com:1337/announce','udp://tracker.openbittorrent.com:80','udp://tracker.coppersurfer.tk:6969','udp://tracker.opentrackr.org:1337/announce','udp://p4p.arenabg.com:1337'].map(t=>`&tr=${encodeURIComponent(t)}`).join('');
        console.log(`✅ YIFY: ${match.title} — ${torrent.quality} — Seeds: ${torrent.seeds}`);
        return { title: match.title, year: match.year, quality: torrent.quality, magnet: `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(match.title)}${tr}`, size: torrent.size, seeds: torrent.seeds };
    } catch (err) { console.error('YIFY error:', err.message); return null; }
}

async function searchEZTV(tmdbId, season, episode) {
    try {
        const details = await tmdbFetch(`/tv/${tmdbId}`, { append_to_response: 'external_ids' });
        const title   = details.name;
        const imdbId  = details.external_ids?.imdb_id;
        if (!title) return null;
        const s = String(season).padStart(2,'0'), e = String(episode).padStart(2,'0');
        console.log(`🔍 EZTV: ${title} S${s}E${e}`);
        const url = imdbId ? `https://eztv.re/api/get-torrents?imdb_id=${imdbId.replace('tt','')}&limit=20` : `https://eztv.re/api/get-torrents?limit=20`;
        const res = await axios.get(url, { timeout: 10000 });
        const torrents = res.data?.torrents || [];
        const epMatch  = torrents.filter(t => { const tn=(t.title||'').toLowerCase(); return tn.includes(`s${s}e${e}`)||tn.includes(`${season}x${e}`); });
        const torrent  = epMatch.find(t=>t.title?.includes('720p')) || epMatch.find(t=>t.title?.includes('1080p')) || epMatch[0];
        if (!torrent) return null;
        console.log(`✅ EZTV: ${torrent.title}`);
        return { title: torrent.title, magnet: torrent.magnet_url, size: torrent.size_bytes, seeds: torrent.seeds };
    } catch (err) { console.error('EZTV error:', err.message); return null; }
}

function streamTorrent(magnetUrl, filename, res, req) {
    return new Promise((resolve, reject) => {
        const client = getWtClient();
        if (!client) return reject(new Error('WebTorrent not available'));
        const timeout = setTimeout(() => reject(new Error('Torrent timeout')), 60000);
        client.add(magnetUrl, { path: os.tmpdir() }, torrent => {
            clearTimeout(timeout);
            const file = torrent.files.reduce((a,b) => a.size>b.size ? a : b);
            console.log(`📦 Streaming: ${file.name} (${(file.length/1024/1024).toFixed(0)}MB)`);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Length', file.length);
            const stream = file.createReadStream();
            stream.on('error', err => { torrent.destroy(); reject(err); });
            stream.pipe(res);
            res.on('close',  () => { torrent.destroy(); resolve(); });
            res.on('finish', () => { torrent.destroy(); resolve(); });
            const iv = setInterval(() => { console.log(`📥 ${(torrent.progress*100).toFixed(1)}% — ${(torrent.downloadSpeed/1024).toFixed(0)} KB/s — Peers: ${torrent.numPeers}`); if(torrent.done) clearInterval(iv); }, 5000);
        });
        client.on('error', err => { clearTimeout(timeout); reject(err); });
    });
}

app.get('/api/download/status', (req, res) => {
    res.json({ success: true, data: {
        ytdlCore: !!ytdl, ytDlp: !!YT_DLP_PATH, webTorrent: !!WebTorrent,
        activeJobs: wtClient ? wtClient.torrents.length : 0,
        features: { trailerDownload: !!YT_DLP_PATH||!!ytdl, movieDownload: !!WebTorrent, tvDownload: !!WebTorrent },
    }});
});

app.get('/api/download/trailer/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const { title = 'trailer' } = req.query;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid YouTube video ID' });
    const filename = safeFilename(title) + '_trailer.mp4';
    const ytUrl    = `https://www.youtube.com/watch?v=${videoId}`;
    if (YT_DLP_PATH) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Transfer-Encoding', 'chunked');
        const proc = spawn(YT_DLP_PATH, [
            '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--output', '-', '--no-playlist', '--quiet', '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
            '--extractor-args', 'youtube:player_client=android,web',
            '--no-check-certificates', '--age-limit', '99', ytUrl,
        ], { stdio: ['ignore','pipe','pipe'] });
        proc.stderr.on('data', d => console.log(`[yt-dlp] ${d.toString().trim()}`));
        proc.stdout.pipe(res);
        proc.on('close', () => { if (!res.writableEnded) res.end(); });
        proc.on('error', err => { if (!res.headersSent) res.status(500).json({ success: false, error: err.message }); });
        req.on('close', () => proc.kill('SIGTERM'));
        return;
    }
    if (ytdl) {
        try {
            const info   = await ytdl.getInfo(ytUrl);
            const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: f => f.container==='mp4'&&f.hasAudio })
                        || ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
            if (!format) return res.status(404).json({ success: false, error: 'No format found' });
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            if (format.contentLength) res.setHeader('Content-Length', format.contentLength);
            const stream = ytdl(ytUrl, { format });
            stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
            stream.pipe(res);
            req.on('close', () => stream.destroy());
        } catch (err) { if (!res.headersSent) res.status(500).json({ success: false, error: err.message }); }
        return;
    }
    res.status(503).json({ success: false, error: 'No download engine available' });
});

app.get('/api/download/:type/:tmdbId', async (req, res) => {
    const { type, tmdbId } = req.params;
    if (type === 'trailer') return res.status(404).json({ success: false, error: 'Use /api/download/trailer/:videoId' });
    if (!['movie','tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
    if (!WebTorrent) return res.status(503).json({ success: false, error: 'WebTorrent not available' });
    const { season=1, episode=1, quality='720p', title='video' } = req.query;
    console.log(`⬇️  Download: ${type} ${tmdbId}`);
    try {
        const torrentInfo = type==='movie'
            ? await searchYIFY(tmdbId, quality==='best'?'720p':quality)
            : await searchEZTV(tmdbId, parseInt(season), parseInt(episode));
        if (!torrentInfo?.magnet) return res.status(404).json({ success: false, error: `No torrent found for this ${type}.` });
        const filename = safeFilename(torrentInfo.title||title) + '.mp4';
        console.log(`🧲 ${torrentInfo.title} — Seeds: ${torrentInfo.seeds}`);
        await streamTorrent(torrentInfo.magnet, filename, res, req);
    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/download/cancel/:id', (req, res) => res.json({ success: true, message: 'Use browser stop button to cancel.' }));

// ============================================================
// ACCOUNTS + CLOUD SYNC  (wishlist / history / continue-watching)
// File-based store (no external service). On Railway/Render attach a
// persistent volume and set DATA_DIR to its mount path, otherwise the
// file is wiped on each redeploy.
// ============================================================
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
let store = { secret: null, users: {}, sync: {} };
try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) };
} catch (e) { console.error('Store load error:', e.message); }
if (!store.secret) store.secret = crypto.randomBytes(32).toString('hex');

let _saveTimer = null;
function persistStore() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        try {
            const tmp = STORE_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(store));
            fs.renameSync(tmp, STORE_FILE);
        } catch (e) { console.error('Store save error:', e.message); }
    }, 400);
}
persistStore();

const b64u = v => Buffer.from(v).toString('base64url');
function signToken(uid) {
    const body = b64u(JSON.stringify({ uid, exp: Date.now() + 30 * 864e5 }));
    const sig  = crypto.createHmac('sha256', store.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
}
function verifyToken(token) {
    try {
        const [body, sig] = String(token).split('.');
        const exp = crypto.createHmac('sha256', store.secret).update(body).digest('base64url');
        if (!sig || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
        const p = JSON.parse(Buffer.from(body, 'base64url').toString());
        return p.exp > Date.now() ? p.uid : null;
    } catch (_) { return null; }
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, user) {
    const h = crypto.scryptSync(pw, user.salt, 64);
    const e = Buffer.from(user.hash, 'hex');
    return h.length === e.length && crypto.timingSafeEqual(h, e);
}
function requireAuth(req, res, next) {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    const uid = m && verifyToken(m[1]);
    if (!uid || !store.users[uid]) return res.status(401).json({ success: false, error: 'Not signed in' });
    req.uid = uid;
    next();
}
const findUserByEmail = email => Object.values(store.users).find(u => u.email === email);
const cleanEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;

app.post('/api/auth/signup', (req, res) => {
    const email = cleanEmail(req.body?.email), password = String(req.body?.password || '');
    if (!validEmail(email)) return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ success: false, error: 'Password must be 8–128 characters.' });
    if (findUserByEmail(email)) return res.status(409).json({ success: false, error: 'An account with this email already exists.' });
    const id = crypto.randomBytes(12).toString('hex');
    store.users[id] = { id, email, ...hashPw(password), createdAt: Date.now() };
    persistStore();
    res.json({ success: true, data: { token: signToken(id), email } });
});

app.post('/api/auth/login', (req, res) => {
    const email = cleanEmail(req.body?.email), password = String(req.body?.password || '');
    const user = findUserByEmail(email);
    if (!user || !checkPw(password, user)) return res.status(401).json({ success: false, error: 'Incorrect email or password.' });
    res.json({ success: true, data: { token: signToken(user.id), email: user.email } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ success: true, data: { email: store.users[req.uid].email } });
});

app.delete('/api/auth/account', requireAuth, (req, res) => {
    delete store.users[req.uid];
    delete store.sync[req.uid];
    persistStore();
    res.json({ success: true });
});

const capArr = (a, n) => Array.isArray(a) ? a.slice(0, n) : [];
app.get('/api/sync', requireAuth, (req, res) => {
    const rec = store.sync[req.uid] || { data: { wishlist: [], history: [], continue: [] }, updatedAt: 0 };
    res.json({ success: true, data: rec });
});
app.put('/api/sync', requireAuth, (req, res) => {
    const d = req.body?.data || {};
    const clean = { wishlist: capArr(d.wishlist, 500), history: capArr(d.history, 80), continue: capArr(d.continue, 20) };
    if (JSON.stringify(clean).length > 600000) return res.status(413).json({ success: false, error: 'Data too large' });
    const updatedAt = Date.now();
    store.sync[req.uid] = { data: clean, updatedAt };
    persistStore();
    res.json({ success: true, data: { updatedAt } });
});

// ── Client-side error log (shows up in your host logs / Sentry) ──
let _clientErrCount = 0;
app.post('/api/client-error', rateLimit({ windowMs: 60 * 1000, max: 20 }), (req, res) => {
    const b = req.body || {};
    const line = `[client-error] ${String(b.message || '').slice(0, 300)} @ ${String(b.source || '').slice(0, 200)}:${b.line || 0} | ${String(b.page || '').slice(0, 120)} | ${String(req.headers['user-agent'] || '').slice(0, 120)}`;
    if (_clientErrCount++ < 500) console.warn(line);
    if (Sentry && process.env.SENTRY_DSN) { try { Sentry.captureMessage(line, 'warning'); } catch (_) {} }
    res.json({ success: true });
});

// ============================================================
// FALLBACKS  (unknown /api → JSON 404, other pages → index.html)
// ============================================================
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html') && !/\.(js|css|map|png|jpe?g|gif|svg|ico|webp|avif|json|txt|xml|woff2?|ttf|otf|mp4|webm|mp3)$/i.test(req.path)) return sendIndex(req, res);
    next();
});

// ============================================================
// START
// ============================================================
if (Sentry && process.env.SENTRY_DSN && Sentry.setupExpressErrorHandler) { try { Sentry.setupExpressErrorHandler(app); } catch (_) {} }
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    if (res.headersSent) return next(err);
    // FIX: pass through err.status so 503 from tmdbFetch reaches the client
    res.status(err.status || 500).json({ success: false, error: err.message || 'Server error' });
});

app.listen(PORT, () => {
    console.log('');
    console.log('🚀 YOUFLEX Backend Starting…');
    console.log(`📡 TMDB:        ${TMDB_API_KEY ? '✅' : '❌ (missing key)'}`);
    console.log(`📺 YouTube:     ${YOUTUBE_API_KEY ? '✅' : '⚠️  (missing key)'}`);
    console.log(`📥 WebTorrent:  ${WebTorrent ? '✅' : '❌'}`);
    console.log(`🔧 yt-dlp:      ${YT_DLP_PATH ? '✅' : '❌'}`);
    console.log(`🗜️  gzip: ${compression ? '✅' : '—'}  🛡️ helmet: ${helmet ? '✅' : '—'}  💾 data dir: ${DATA_DIR}`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s=>s.name).join(', ')}`);
    console.log('');
    console.log(`🚀 YOUFLEX Backend v3.6 running on port ${PORT}`);
});
