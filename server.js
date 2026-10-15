// ============================================================
// YOUFLEX BACKEND v3.5 — Complete Edition
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
app.get('/api/health', (req, res) => res.json({ success: true, service: 'YOUFLEX API', version: '3.5', timestamp: new Date().toISOString() }));

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
app.get('/api/trending', async (req, res) => {
    try {
        const { type = 'all', page = 1 } = req.query;
        const data = await tmdbFetch(`/trending/${type}/week`, { page });
        res.json({ success: true, data: data.results || [] });
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
            append_to_response: 'credits,videos,similar,recommendations,external_ids,watch/providers',
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
// EMBED SOURCES   — FIXED response shape (label / embedUrl / allSources)
// Dead hosts (vidsrc.xyz, embed.su) removed.
// ============================================================
const EMBED_SOURCES = [
    { name: 'Source 1', movie: id => `https://vidsrc.me/embed/movie?tmdb=${id}`,
                        tv: (id,s,e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 2', movie: id => `https://vidsrc.to/embed/movie/${id}`,
                        tv: (id,s,e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
    { name: 'Source 3', movie: id => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`,
                        tv: (id,s,e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
    { name: 'Source 4', movie: id => `https://www.smashystream.xyz/playere.php?tmdb=${id}`,
                        tv: (id,s,e) => `https://www.smashystream.xyz/playere.php?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 5', movie: id => `https://www.2embed.cc/embed/${id}`,
                        tv: (id,s,e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}` },
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
// CLIPS  — paste this whole block into server.js, right ABOVE the
//          "// FALLBACKS" section. Uses the existing tmdbFetch, axios,
//          checkEmbeddable, rateLimit and YOUTUBE_API_KEY.
// GET /api/clips?category=&type=all|movie|tv&genre=&sort=popular|recent&page=&q=
// Sources: TMDB clips/featurettes (YouTube-hosted) + embeddable-only
// YouTube search as a top-up. Every clip is checked with oEmbed so only
// videos the owner allows to be embedded are returned.
// ============================================================
const CLIP_GENRES = {
    action:{movie:28,tv:10759},  comedy:{movie:35,tv:35},     drama:{movie:18,tv:18},
    horror:{movie:27,tv:9648},   romance:{movie:10749,tv:null}, scifi:{movie:878,tv:10765},
    animation:{movie:16,tv:16},  crime:{movie:80,tv:80},      fantasy:{movie:14,tv:10765},
    thriller:{movie:53,tv:9648}, documentary:{movie:99,tv:99},
};
const FIGHT_RE = /fight|battle|duel|showdown|brawl|chase|face.?off|attack/i;
const EMO_RE   = /emotional|tears|goodbye|farewell|heartbreak|reunion|touching|sad|confession|proposal|wedding|love/i;
const CLIP_CATS = {
    trending:{}, action:{genre:'action'}, comedy:{genre:'comedy'}, drama:{genre:'drama'},
    horror:{genre:'horror'}, romance:{genre:'romance'}, scifi:{genre:'scifi'},
    fights:   { genre:'action', re:FIGHT_RE, yt:'best movie fight scenes official clip' },
    emotional:{ genre:'drama',  re:EMO_RE,   yt:'most emotional movie scenes official clip' },
    movies:{type:'movie'}, tv:{type:'tv'},
};
const CLIP_KINDS    = new Set(['Clip', 'Featurette', 'Behind the Scenes']);
const CLIP_EXCLUDED = ['trailer', 'teaser', 'reaction', 'react', 'review', 'recap', 'explained', 'ranked', '#shorts', '| shorts'];
const clipCache = new Map();             // key -> { ts, data }
const clipOkCache = new Map();           // videoId -> embeddable?
const CLIP_TTL = 10 * 60 * 1000;
const interleave = (a, b) => { const o = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) o.push(a[i]); if (b[i]) o.push(b[i]); } return o; };

async function clipPlayable(id) {
    if (clipOkCache.has(id)) return clipOkCache.get(id);
    const r = await checkEmbeddable(id);
    const ok = r.ok !== false;
    if (r.ok !== null) { clipOkCache.set(id, ok); if (clipOkCache.size > 5000) clipOkCache.clear(); }
    return ok;
}

// Which titles to pull clips from
async function clipPool(cat, type, genre, page, q) {
    const cfg = CLIP_CATS[cat] || CLIP_CATS.trending;
    if (cfg.type) type = cfg.type;
    if (q) {
        const d = await tmdbFetch('/search/multi', { query: q, page });
        const items = (d.results || []).filter(r => (r.media_type === 'movie' || r.media_type === 'tv')
            && (type === 'all' || r.media_type === type)
            && (!genre || (r.genre_ids || []).includes(CLIP_GENRES[genre][r.media_type])));
        return { items, total: d.total_pages || 1 };
    }
    const slug  = genre || cfg.genre || '';
    const types = type === 'all' ? ['movie', 'tv'] : [type];
    if (slug && CLIP_GENRES[slug]) {
        const lists = await Promise.all(types.map(async t => {
            const gid = CLIP_GENRES[slug][t];
            if (!gid) return { results: [], total_pages: 0 };
            const d = await tmdbFetch(`/discover/${t}`, { page, with_genres: gid, sort_by: 'popularity.desc', 'vote_count.gte': 50 });
            return { results: (d.results || []).map(r => ({ ...r, media_type: t })), total_pages: d.total_pages || 1 };
        }));
        return { items: lists.map(l => l.results).reduce(interleave, []), total: Math.max(...lists.map(l => l.total_pages)) };
    }
    if (cat === 'movies' || cat === 'tv') {
        const t = cat === 'movies' ? 'movie' : 'tv';
        const d = await tmdbFetch(`/${t}/popular`, { page });
        return { items: (d.results || []).map(r => ({ ...r, media_type: t })), total: d.total_pages || 1 };
    }
    const d = await tmdbFetch(`/trending/${type}/week`, { page });
    return { items: (d.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv'), total: d.total_pages || 1 };
}

// Up to 3 clips per title, so one title can't flood the page
async function clipsForTitle(item, re) {
    const t = item.media_type;
    let d; try { d = await tmdbFetch(`/${t}/${item.id}/videos`, { include_video_language: 'en,null' }); } catch (_) { return []; }
    const media = {
        id: item.id, type: t, title: item.title || item.name, poster: item.poster_path, backdrop: item.backdrop_path,
        vote: item.vote_average || 0, popularity: item.popularity || 0,
        year: (item.release_date || item.first_air_date || '').slice(0, 4),
    };
    return (d.results || [])
        .filter(v => v.site === 'YouTube' && v.key && CLIP_KINDS.has(v.type)
            && !CLIP_EXCLUDED.some(x => (v.name || '').toLowerCase().includes(x))
            && (!re || re.test(v.name || '')))
        .slice(0, 3)
        .map(v => ({ videoId: v.key, name: v.name, kind: v.type, published_at: v.published_at,
                     thumb: `https://i.ytimg.com/vi/${v.key}/hqdefault.jpg`, media }));
}

// YouTube top-up: embeddable videos only
async function ytClipSearch(query, max = 12) {
    if (!YOUTUBE_API_KEY) return [];
    try {
        const r = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: { key: YOUTUBE_API_KEY, q: query, part: 'snippet', type: 'video', maxResults: max, videoEmbeddable: 'true', relevanceLanguage: 'en' },
            timeout: 10000,
        });
        return (r.data?.items || []).filter(i => i.id?.videoId && !CLIP_EXCLUDED.some(x => (i.snippet?.title || '').toLowerCase().includes(x)))
            .map(i => ({ videoId: i.id.videoId, name: i.snippet.title, kind: 'YouTube', published_at: i.snippet.publishedAt,
                         thumb: i.snippet.thumbnails?.high?.url || `https://i.ytimg.com/vi/${i.id.videoId}/hqdefault.jpg`,
                         channel: i.snippet.channelTitle, media: null }));
    } catch (err) { console.error('Clips YouTube error:', err.message); return []; }
}

app.use('/api/clips', rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.get('/api/clips', async (req, res) => {
    try {
        const cat   = CLIP_CATS[req.query.category] ? req.query.category : 'trending';
        const type  = ['movie', 'tv'].includes(req.query.type) ? req.query.type : 'all';
        const genre = CLIP_GENRES[req.query.genre] ? req.query.genre : '';
        const sort  = req.query.sort === 'recent' ? 'recent' : 'popular';
        const page  = Math.min(Math.max(parseInt(req.query.page) || 1, 1), 20);
        const q     = String(req.query.q || '').trim().slice(0, 80);
        const key   = JSON.stringify([cat, type, genre, sort, page, q]);
        const hit   = clipCache.get(key);
        if (hit && Date.now() - hit.ts < CLIP_TTL) return res.json({ success: true, data: hit.data });

        const cfg  = CLIP_CATS[cat];
        const pool = await clipPool(cat, type, genre, page, q);
        const groups = await Promise.all(pool.items.slice(0, 20).map(it => clipsForTitle(it, cfg.re)));
        let clips = groups.flat();
        if (clips.length < 8 && page === 1 && (q || cfg.yt) && (type === 'all')) {
            clips = clips.concat(await ytClipSearch(q ? `${q} official movie clip` : cfg.yt));
        }
        const seen = new Set();
        clips = clips.filter(c => !seen.has(c.videoId) && seen.add(c.videoId)).slice(0, 48);
        const ok = await Promise.all(clips.map(c => clipPlayable(c.videoId)));
        clips = clips.filter((_, i) => ok[i]);
        clips.sort(sort === 'recent'
            ? (a, b) => String(b.published_at).localeCompare(String(a.published_at))
            : (a, b) => (b.media?.popularity || 0) - (a.media?.popularity || 0));

        const data = { clips, page, hasMore: page < pool.total && page < 20 };
        clipCache.set(key, { ts: Date.now(), data });
        if (clipCache.size > 300) clipCache.delete(clipCache.keys().next().value);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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
    res.status(err.status || 500).json({ success: false, error: 'Server error' });
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
    console.log(`🚀 YOUFLEX Backend v3.5 running on port ${PORT}`);
});
