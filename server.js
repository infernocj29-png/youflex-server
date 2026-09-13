// ============================================================
// YOUFLEX BACKEND v3.0 — Railway Edition
// ============================================================
'use strict';

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const path       = require('path');
const os         = require('os');
const { spawn, execSync } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 10000;

// ── API Keys ──────────────────────────────────────────────────
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';
const TMDB_BASE       = 'https://api.themoviedb.org/3';

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
    origin: [
        'https://youflex.netlify.app',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
    ],
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
        const query = `${title} ${year} official trailer ${type === 'tv' ? 'series' : 'movie'}`;
        const res = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
                key: YOUTUBE_API_KEY,
                q: query,
                part: 'snippet',
                type: 'video',
                videoDefinition: 'high',
                videoDuration: 'medium',
                maxResults: 10,
                relevanceLanguage: 'en',
            },
            timeout: 10000,
        });

        const items    = res.data?.items || [];
        const excluded = ['behind the scenes', 'bts', 'clip', 'featurette', 'short', 'bloopers', 'deleted', 'making of', 'interview'];

        const trailers = items.filter(item => {
            const t = (item.snippet?.title || '').toLowerCase();
            return (t.includes('trailer') || t.includes('teaser')) &&
                   !excluded.some(ex => t.includes(ex));
        });

        const official = trailers.find(i => i.snippet?.title?.toLowerCase().includes('official'));
        const best     = official || trailers[0] || items[0];
        return best ? best.id?.videoId : null;
    } catch (err) {
        console.error('YouTube trailer error:', err.message);
        return null;
    }
}

// ── yt-dlp detection ──────────────────────────────────────────
function getYtDlpPath() {
    const candidates = [
        path.join(__dirname, 'bin/yt-dlp'),
        '/opt/render/project/src/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        'yt-dlp',
    ];
    for (const p of candidates) {
        try {
            execSync(`"${p}" --version`, { stdio: 'pipe', timeout: 5000 });
            return p;
        } catch (_) {}
    }
    return null;
}

let YT_DLP_PATH = null;
try {
    YT_DLP_PATH = getYtDlpPath();
    console.log(YT_DLP_PATH ? `✅ yt-dlp found at: ${YT_DLP_PATH}` : '⚠️  yt-dlp not found');
} catch (_) {}

// ── ytdl-core ─────────────────────────────────────────────────
let ytdl = null;
try {
    ytdl = require('@distube/ytdl-core');
    console.log('✅ ytdl-core loaded');
} catch (_) { console.warn('⚠️  ytdl-core not found'); }

// ── WebTorrent ────────────────────────────────────────────────
let WebTorrent = null;
let wtClient   = null;
try {
    WebTorrent = require('webtorrent');
    console.log('✅ WebTorrent loaded');
} catch (_) { console.warn('⚠️  WebTorrent not found'); }

function getWtClient() {
    if (!wtClient && WebTorrent) {
        wtClient = new WebTorrent();
        wtClient.on('error', err => console.error('WebTorrent error:', err.message));
    }
    return wtClient;
}

function safeFilename(str) {
    return (str || 'video').replace(/[^\w\s\-().]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

// ============================================================
// TMDB ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
    res.json({ success: true, service: 'YOUFLEX API', version: '3.0', timestamp: new Date().toISOString() });
});

app.get('/api/trending/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/trending/${req.params.type}/week`, { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/popular/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/popular`, { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/top-rated/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/${req.params.type}/top_rated`, { page: req.query.page || 1 });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/search', async (req, res) => {
    try {
        if (!req.query.q) return res.status(400).json({ success: false, error: 'Query required' });
        const data = await tmdbFetch('/search/multi', { query: req.query.q, page: req.query.page || 1 });
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

app.get('/api/tv/:id/season/:season', async (req, res) => {
    try {
        const data = await tmdbFetch(`/tv/${req.params.id}/season/${req.params.season}`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/person/:id', async (req, res) => {
    try {
        const data = await tmdbFetch(`/person/${req.params.id}`, {
            append_to_response: 'movie_credits,tv_credits,external_ids',
        });
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/genres/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/genre/${req.params.type}/list`);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/discover/:type', async (req, res) => {
    try {
        const data = await tmdbFetch(`/discover/${req.params.type}`, req.query);
        res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================================
// YOUTUBE ROUTES
// ============================================================

app.get('/api/trailer/:type/:id', async (req, res) => {
    try {
        const { type, id } = req.params;
        const details  = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos   = details.videos?.results || [];
        const excluded = ['behind the scenes', 'bts', 'clip', 'featurette', 'short', 'bloopers', 'deleted scenes', 'making of', 'interview'];

        const trailers = videos.filter(v => {
            const t = (v.name || '').toLowerCase();
            return v.site === 'YouTube' &&
                   (v.type === 'Trailer' || v.type === 'Teaser') &&
                   !excluded.some(ex => t.includes(ex));
        });

        const official    = trailers.find(v => v.name?.toLowerCase().includes('official'));
        const tmdbTrailer = official || trailers[0];

        if (tmdbTrailer) {
            return res.json({ success: true, data: { videoId: tmdbTrailer.key, title: tmdbTrailer.name, source: 'tmdb' } });
        }

        // Fallback to YouTube search
        const title   = details.title || details.name;
        const year    = (details.release_date || details.first_air_date || '').split('-')[0];
        const videoId = await getYouTubeTrailer(title, year, type);

        if (videoId) {
            return res.json({ success: true, data: { videoId, title: `${title} Official Trailer`, source: 'youtube' } });
        }

        res.status(404).json({ success: false, error: 'No trailer found' });
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
// EMBED ROUTES
// ============================================================

const EMBED_SOURCES = [
    { name: 'Source 1', movie: id => `https://vidsrc.me/embed/movie?tmdb=${id}`, tv: (id,s,e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 2', movie: id => `https://vidsrc.to/embed/movie/${id}`, tv: (id,s,e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}` },
    { name: 'Source 3', movie: id => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1`, tv: (id,s,e) => `https://multiembed.mov/directstream.php?video_id=${id}&tmdb=1&s=${s}&e=${e}` },
    { name: 'Source 4', movie: id => `https://vidsrc.xyz/embed/movie?tmdb=${id}`, tv: (id,s,e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}` },
    { name: 'Source 5', movie: id => `https://embed.su/embed/movie/${id}`, tv: (id,s,e) => `https://embed.su/embed/tv/${id}/${s}/${e}` },
];

app.get('/api/embed/movie/:tmdbId', (req, res) => {
    const sources = EMBED_SOURCES.map(s => ({ name: s.name, url: s.movie(req.params.tmdbId) }));
    res.json({ success: true, data: { sources } });
});

app.get('/api/embed/tv/:tmdbId/:season/:episode', (req, res) => {
    const { tmdbId, season, episode } = req.params;
    const sources = EMBED_SOURCES.map(s => ({ name: s.name, url: s.tv(tmdbId, season, episode) }));
    res.json({ success: true, data: { sources } });
});

app.get('/api/embed/sources/:type/:tmdbId', (req, res) => {
    const { type, tmdbId } = req.params;
    const { season = 1, episode = 1 } = req.query;
    const sources = EMBED_SOURCES.map(s => ({
        name: s.name,
        url: type === 'tv' ? s.tv(tmdbId, season, episode) : s.movie(tmdbId),
    }));
    res.json({ success: true, data: { sources } });
});

// ============================================================
// DOWNLOAD ROUTES
// ============================================================

async function searchYIFY(tmdbId, quality = '720p') {
    try {
        const details = await tmdbFetch(`/movie/${tmdbId}`);
        const title   = details.title;
        const year    = details.release_date?.split('-')[0];
        if (!title) return null;

        console.log(`🔍 Searching YIFY for: ${title} (${year})`);

        const apis = [
            `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=5`,
            `https://yts.lt/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&limit=5`,
        ];

        let movies = [];
        for (const url of apis) {
            try {
                const res = await axios.get(url, { timeout: 8000 });
                movies = res.data?.data?.movies || [];
                if (movies.length) break;
            } catch (_) { continue; }
        }

        if (!movies.length) return null;

        const match   = movies.find(m => String(m.year) === String(year) || m.title.toLowerCase() === title.toLowerCase()) || movies[0];
        const torrents = match.torrents || [];
        const torrent  = torrents.find(t => t.quality === quality) || torrents.find(t => t.quality === '720p') || torrents[0];
        if (!torrent) return null;

        const trackers = [
            'udp://open.demonii.com:1337/announce',
            'udp://tracker.openbittorrent.com:80',
            'udp://tracker.coppersurfer.tk:6969',
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://p4p.arenabg.com:1337',
        ].map(t => `&tr=${encodeURIComponent(t)}`).join('');

        console.log(`✅ Found: ${match.title} (${match.year}) — ${torrent.quality} — Seeds: ${torrent.seeds}`);

        return {
            title:  match.title,
            year:   match.year,
            quality: torrent.quality,
            magnet: `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(match.title)}${trackers}`,
            size:   torrent.size,
            seeds:  torrent.seeds,
        };
    } catch (err) {
        console.error('YIFY search error:', err.message);
        return null;
    }
}

async function searchEZTV(tmdbId, season, episode) {
    try {
        const details = await tmdbFetch(`/tv/${tmdbId}`, { append_to_response: 'external_ids' });
        const title   = details.name;
        const imdbId  = details.external_ids?.imdb_id;
        if (!title) return null;

        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');

        console.log(`🔍 Searching EZTV for: ${title} S${s}E${e}`);

        const url = imdbId
            ? `https://eztv.re/api/get-torrents?imdb_id=${imdbId.replace('tt', '')}&limit=20`
            : `https://eztv.re/api/get-torrents?limit=20`;

        const res      = await axios.get(url, { timeout: 10000 });
        const torrents = res.data?.torrents || [];

        const epMatch = torrents.filter(t => {
            const tn = (t.title || '').toLowerCase();
            return tn.includes(`s${s}e${e}`) || tn.includes(`${season}x${e}`);
        });

        const torrent = epMatch.find(t => t.title?.includes('720p'))
            || epMatch.find(t => t.title?.includes('1080p'))
            || epMatch[0];

        if (!torrent) return null;

        console.log(`✅ Found: ${torrent.title}`);
        return { title: torrent.title, magnet: torrent.magnet_url, size: torrent.size_bytes, seeds: torrent.seeds };
    } catch (err) {
        console.error('EZTV search error:', err.message);
        return null;
    }
}

function streamTorrent(magnetUrl, filename, res, req) {
    return new Promise((resolve, reject) => {
        const client = getWtClient();
        if (!client) return reject(new Error('WebTorrent not available'));

        const timeout = setTimeout(() => reject(new Error('Torrent timeout — no peers found')), 60000);

        client.add(magnetUrl, { path: os.tmpdir() }, torrent => {
            clearTimeout(timeout);
            const file = torrent.files.reduce((a, b) => a.size > b.size ? a : b);
            console.log(`📦 Streaming: ${file.name} (${(file.length / 1024 / 1024).toFixed(0)}MB)`);

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Length', file.length);

            const stream = file.createReadStream();
            stream.on('error', err => { torrent.destroy(); reject(err); });
            stream.pipe(res);
            res.on('close',  () => { torrent.destroy(); resolve(); });
            res.on('finish', () => { torrent.destroy(); resolve(); });

            const iv = setInterval(() => {
                console.log(`📥 ${(torrent.progress * 100).toFixed(1)}% — ${(torrent.downloadSpeed / 1024).toFixed(0)} KB/s — Peers: ${torrent.numPeers}`);
                if (torrent.done) clearInterval(iv);
            }, 5000);
        });

        client.on('error', err => { clearTimeout(timeout); reject(err); });
    });
}

app.get('/api/download/status', (req, res) => {
    res.json({
        success: true,
        data: {
            ytdlCore:   !!ytdl,
            ytDlp:      !!YT_DLP_PATH,
            webTorrent: !!WebTorrent,
            activeJobs: wtClient ? wtClient.torrents.length : 0,
            features: {
                trailerDownload: !!YT_DLP_PATH || !!ytdl,
                movieDownload:   !!WebTorrent,
                tvDownload:      !!WebTorrent,
            },
        },
    });
});

app.get('/api/download/trailer/:videoId', async (req, res) => {
    const { videoId } = req.params;
    const { title = 'trailer' } = req.query;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid YouTube video ID' });

    const filename = safeFilename(title) + '_trailer.mp4';
    const ytUrl    = `https://www.youtube.com/watch?v=${videoId}`;

    // Try yt-dlp first
    if (YT_DLP_PATH) {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Transfer-Encoding', 'chunked');

        const proc = spawn(YT_DLP_PATH, [
            '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
            '--output', '-',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            '--extractor-args', 'youtube:player_client=android',
            '--no-check-certificates',
            ytUrl,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        proc.stderr.on('data', d => console.log(`[yt-dlp] ${d.toString().trim()}`));
        proc.stdout.pipe(res);
        proc.on('close', code => { if (!res.writableEnded) res.end(); });
        proc.on('error', err => { if (!res.headersSent) res.status(500).json({ success: false, error: err.message }); });
        req.on('close', () => proc.kill('SIGTERM'));
        return;
    }

    // Fallback ytdl-core
    if (ytdl) {
        try {
            const info   = await ytdl.getInfo(ytUrl);
            const format = ytdl.chooseFormat(info.formats, { quality: 'highestvideo', filter: f => f.container === 'mp4' && f.hasAudio })
                        || ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });

            if (!format) return res.status(404).json({ success: false, error: 'No format found' });

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            if (format.contentLength) res.setHeader('Content-Length', format.contentLength);

            const stream = ytdl(ytUrl, { format });
            stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
            stream.pipe(res);
            req.on('close', () => stream.destroy());
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
        }
        return;
    }

    res.status(503).json({ success: false, error: 'No download engine available' });
});

app.get('/api/download/:type/:tmdbId', async (req, res) => {
    const { type, tmdbId } = req.params;

    if (type === 'trailer')
        return res.status(404).json({ success: false, error: 'Use /api/download/trailer/:videoId' });

    if (!['movie', 'tv'].includes(type))
        return res.status(400).json({ success: false, error: 'type must be movie or tv' });

    if (!WebTorrent)
        return res.status(503).json({ success: false, error: 'WebTorrent not available' });

    const { season = 1, episode = 1, quality = '720p', title = 'video' } = req.query;

    console.log(`⬇️  Download: ${type} ${tmdbId} S${season}E${episode}`);

    try {
        const torrentInfo = type === 'movie'
            ? await searchYIFY(tmdbId, quality === 'best' ? '720p' : quality)
            : await searchEZTV(tmdbId, parseInt(season), parseInt(episode));

        if (!torrentInfo?.magnet) {
            return res.status(404).json({ success: false, error: `No torrent found for this ${type}.` });
        }

        const filename = safeFilename(torrentInfo.title || title) + '.mp4';
        console.log(`🧲 Torrent: ${torrentInfo.title} — Seeds: ${torrentInfo.seeds}`);
        await streamTorrent(torrentInfo.magnet, filename, res, req);
    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/download/cancel/:id', (req, res) => {
    res.json({ success: true, message: 'Use the browser stop button to cancel.' });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
    console.log('');
    console.log('🚀 YOUFLEX Backend Starting…');
    console.log(`📡 TMDB:       ✅`);
    console.log(`📺 YouTube:    ✅`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s => s.name).join(', ')}`);
    console.log(`📥 WebTorrent: ${WebTorrent ? '✅' : '❌'}`);
    console.log(`🔧 yt-dlp:     ${YT_DLP_PATH ? '✅' : '❌'}`);
    console.log('');
    console.log(`🚀 YOUFLEX Backend v3.0 running on port ${PORT}`);
    console.log(`📺 TV:     GET /api/embed/tv/:tmdbId/:season/:episode`);
    console.log(`🎬 Movie:  GET /api/embed/movie/:tmdbId`);
    console.log(`📋 Sources: GET /api/embed/sources/:type/:tmdbId`);
    console.log(`⬇️  Download: GET /api/download/:type/:tmdbId`);
    console.log(`🎥 Trailer: GET /api/download/trailer/:videoId ✅`);
});
