// ============================================================
// YOUFLEX BACKEND v3.4 — Complete Edition
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

const app  = express();
const PORT = process.env.PORT || 10000;

// ⚠️ Set these in your host's Environment Variables (Railway / Render).
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const TMDB_BASE       = 'https://api.themoviedb.org/3';

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
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
    maxAge: 86400,
}));
app.use(express.json());

// ── Frontend hosting: this server also serves index.html + assets ──
// Never expose backend source / config through the static handler
app.use((req, res, next) => {
    if (/^\/(server\.js|package(-lock)?\.json|\.env.*|\.git.*|bin\/|node_modules\/)|\.md$/i.test(req.path)) {
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

// ── TMDB helper ───────────────────────────────────────────────
async function tmdbFetch(endpoint, params = {}) {
    const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
        params: { api_key: TMDB_API_KEY, ...params },
        timeout: 10000,
    });
    return res.data;
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
app.get('/api/health', (req, res) => res.json({ success: true, service: 'YOUFLEX API', version: '3.4', timestamp: new Date().toISOString() }));

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
// FALLBACKS  (unknown /api → JSON 404, other pages → index.html)
// ============================================================
app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Not found' }));
app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html') && !path.extname(req.path)) return sendIndex(req, res);
    next();
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 YOUFLEX Backend Starting…');
    console.log(`📡 TMDB:        ${TMDB_API_KEY ? '✅' : '❌ (missing key)'}`);
    console.log(`📺 YouTube:     ${YOUTUBE_API_KEY ? '✅' : '⚠️  (missing key)'}`);
    console.log(`📥 WebTorrent:  ${WebTorrent ? '✅' : '❌'}`);
    console.log(`🔧 yt-dlp:      ${YT_DLP_PATH ? '✅' : '❌'}`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s=>s.name).join(', ')}`);
    console.log('');
    console.log(`🚀 YOUFLEX Backend v3.4 running on port ${PORT}`);
});
