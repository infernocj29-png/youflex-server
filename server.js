// ============================================================
// YOUFLEX BACKEND v3.2 — Complete Edition
// ============================================================
'use strict';

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const os      = require('os');
const { spawn, execSync } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 10000;

const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';
const TMDB_BASE       = 'https://api.themoviedb.org/3';

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
    origin: ['https://youflex.netlify.app', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── TMDB helper ───────────────────────────────────────────────
async function tmdbFetch(endpoint, params = {}) {
    const res = await axios.get(`${TMDB_BASE}${endpoint}`, {
        params: { api_key: TMDB_API_KEY, ...params },
        timeout: 10000,
    });
    return res.data;
}

// ── YouTube trailer helper ────────────────────────────────────
async function getYouTubeTrailer(title, year, type) {
    try {
        const excluded = ['behind the scenes', 'bts', 'clip', 'featurette', 'short', '#shorts', 'bloopers', 'deleted', 'making of', 'interview', 'reaction', 'review'];
        const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                key: YOUTUBE_API_KEY,
                q: `${title} ${year} official trailer ${type === 'tv' ? 'series' : 'movie'} -shorts`,
                part: 'snippet',
                type: 'video',
                videoDefinition: 'high',
                videoDuration: 'medium',
                maxResults: 10,
                relevanceLanguage: 'en',
                videoEmbeddable: 'true',
            },
            timeout: 10000,
        });
        const items    = res.data?.items || [];
        const trailers = items.filter(i => {
            const t       = (i.snippet?.title || '').toLowerCase();
            const isShort = t.includes('#short') || t.includes('short film') || t.includes('| shorts');
            return (t.includes('trailer') || t.includes('teaser')) && !excluded.some(ex => t.includes(ex)) && !isShort;
        });
        const best = trailers.find(i => i.snippet?.title?.toLowerCase().includes('official')) || trailers[0] || items[0];
        return best ? best.id?.videoId : null;
    } catch (err) {
        console.error('YouTube trailer error:', err.message);
        return null;
    }
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
app.get('/api/health', (req, res) => res.json({ success: true, service: 'YOUFLEX API', version: '3.2', timestamp: new Date().toISOString() }));

// ============================================================
// GENRES
// ============================================================
app.get('/api/genres/all', async (req, res) => {
    try {
        const [movies, tv] = await Promise.all([tmdbFetch('/genre/movie/list'), tmdbFetch('/genre/tv/list')]);
        const all = {};
        [...(movies.genres||[]), ...(tv.genres||[])].forEach(g => { all[g.id] = g.name; });
        res.json(all);
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
        res.json(data.results || []);
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
        res.json(data); // Return directly — index.html uses item.title, item.overview etc
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
// CREDITS
// ============================================================
app.get('/api/credits/:type/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/${req.params.id}/credits`);
        res.json(data); // Return directly — index.html uses data.cast
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// EPISODES
// ============================================================
app.get('/api/episodes/:tvId/:season', async (req, res) => {
    try {
        const data = await tmdbFetch(`/tv/${req.params.tvId}/season/${req.params.season}`);
        res.json({ success: true, episodes: data.episodes || [], season: data });
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
        res.json(data); // Return directly — index.html uses data.results
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
        res.json(data); // Return directly — index.html uses data.results
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
        const details  = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos   = details.videos?.results || [];
        const excluded = ['behind the scenes', 'bts', 'clip', 'featurette', 'short', 'bloopers', 'deleted scenes', 'making of', 'interview'];
        const trailers = videos.filter(v => {
            const t = (v.name || '').toLowerCase();
            return v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && !excluded.some(ex => t.includes(ex));
        });
        const official    = trailers.find(v => v.name?.toLowerCase().includes('official'));
        const tmdbTrailer = official || trailers[0];
        if (tmdbTrailer) return res.json({ success: true, data: { videoId: tmdbTrailer.key, title: tmdbTrailer.name, source: 'tmdb' } });
        const title   = details.title || details.name;
        const year    = (details.release_date || details.first_air_date || '').split('-')[0];
        const videoId = await getYouTubeTrailer(title, year, type);
        if (videoId) return res.json({ success: true, data: { videoId, title: `${title} Official Trailer`, source: 'youtube' } });
        res.status(404).json({ success: false, error: 'No trailer found' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// YouTube video stats (views, likes, channel)
app.get('/api/youtube/video/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;
        const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
            params: { key: YOUTUBE_API_KEY, id: videoId, part: 'snippet,statistics' },
            timeout: 10000,
        });
        const item = response.data?.items?.[0];
        if (!item) return res.status(404).json({ success: false, error: 'Video not found' });
        res.json({ success: true, data: {
            videoId,
            title: item.snippet?.title,
            channelTitle: item.snippet?.channelTitle,
            viewCount: item.statistics?.viewCount,
            likeCount: item.statistics?.likeCount,
        }});
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

// ============================================================
// EMBED SOURCES
// ============================================================
const EMBED_SOURCES = [
    { name: 'Source 1', movie: id => `https://vidsrc.me/embed/movie?tmdb=${id}`,       tv: (id,s,e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 2', movie: id => `https://vidsrc.to/embed/movie/${id}`,             tv: (id,s,e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
    { name: 'Source 3', movie: id => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`, tv: (id,s,e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
    { name: 'Source 4', movie: id => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,       tv: (id,s,e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 5', movie: id => `https://embed.su/embed/movie/${id}`,              tv: (id,s,e) => `https://embed.su/embed/tv/${id}/${s}/${e}` },
];

app.get('/api/embed/movie/:tmdbId', (req, res) => {
    res.json({ success: true, data: { sources: EMBED_SOURCES.map(s => ({ name: s.name, url: s.movie(req.params.tmdbId) })) } });
});

app.get('/api/embed/tv/:tmdbId/:season/:episode', (req, res) => {
    const { tmdbId, season, episode } = req.params;
    res.json({ success: true, data: { sources: EMBED_SOURCES.map(s => ({ name: s.name, url: s.tv(tmdbId, season, episode) })) } });
});

app.get('/api/embed/sources/:type/:tmdbId', (req, res) => {
    const { type, tmdbId } = req.params;
    const { season = 1, episode = 1 } = req.query;
    res.json({ success: true, data: { sources: EMBED_SOURCES.map(s => ({ name: s.name, url: type === 'tv' ? s.tv(tmdbId, season, episode) : s.movie(tmdbId) })) } });
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
// START
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 YOUFLEX Backend Starting…');
    console.log(`📡 TMDB:        ✅`);
    console.log(`📺 YouTube:     ✅`);
    console.log(`📥 WebTorrent:  ${WebTorrent ? '✅' : '❌'}`);
    console.log(`🔧 yt-dlp:      ${YT_DLP_PATH ? '✅' : '❌'}`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s=>s.name).join(', ')}`);
    console.log('');
    console.log(`🚀 YOUFLEX Backend v3.2 running on port ${PORT}`);
});
