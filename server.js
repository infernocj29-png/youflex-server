const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

// ── ytdl-core (optional) ──
let ytdl = null;
try {
    ytdl = require('@distube/ytdl-core');
    console.log('✅ ytdl-core loaded');
} catch (_) {
    console.warn('⚠️  ytdl-core not installed — stream proxy disabled');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// API KEYS
// ============================================================
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Starting…');
console.log(`📡 TMDB:    ${TMDB_API_KEY    ? '✅' : '❌ Missing'}`);
console.log(`📡 YouTube: ${YOUTUBE_API_KEY ? '✅' : '❌ Missing'}`);

// ============================================================
// MIDDLEWARE
// ============================================================
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:3000',
    'https://youflex.onrender.com',
    'https://youflex-server.onrender.com',
    process.env.FRONTEND_URL,
    process.env.RENDER_EXTERNAL_URL,
].filter(Boolean);

app.use(cors({
    origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, true); // allow all for now
    },
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

// ============================================================
// KEEP-ALIVE (prevents Render free tier sleep)
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
    axios.get(`${SELF_URL}/api/health`).catch(() => {});
}, 14 * 60 * 1000); // ping every 14 minutes

// ============================================================
// CACHE CLASS
// ============================================================
class Cache {
    constructor(ttl = 5 * 60 * 1000) { this.store = new Map(); this.ttl = ttl; }
    set(key, value) { this.store.set(key, { value, ts: Date.now() }); }
    get(key) {
        const e = this.store.get(key);
        if (!e) return null;
        if (Date.now() - e.ts > this.ttl) { this.store.delete(key); return null; }
        return e.value;
    }
    clear() { this.store.clear(); }
    stats() {
        let total = 0, expired = 0;
        for (const [, e] of this.store) {
            total++;
            if (Date.now() - e.ts > this.ttl) expired++;
        }
        return { total, expired, active: total - expired };
    }
}

const C = {
    trending:        new Cache(3  * 60 * 1000),
    details:         new Cache(10 * 60 * 1000),
    search:          new Cache(2  * 60 * 1000),
    genres:          new Cache(30 * 60 * 1000),
    credits:         new Cache(10 * 60 * 1000),
    similar:         new Cache(10 * 60 * 1000),
    providers:       new Cache(10 * 60 * 1000),
    episodes:        new Cache(10 * 60 * 1000),
    youtube:         new Cache(5  * 60 * 1000),
    embed:           new Cache(60 * 60 * 1000),
    recommendations: new Cache(30 * 60 * 1000),
    trailer:         new Cache(30 * 60 * 1000),
    seasons:         new Cache(10 * 60 * 1000),
};

function cacheMW(cache, keyFn = null) {
    return (req, res, next) => {
        const key    = keyFn ? keyFn(req) : req.originalUrl;
        const cached = cache.get(key);
        if (cached) {
            res.setHeader('X-Cache', 'HIT');
            return res.json(cached);
        }
        const orig = res.json.bind(res);
        res.json = data => {
            cache.set(key, data);
            res.setHeader('X-Cache', 'MISS');
            orig(data);
        };
        next();
    };
}

// ============================================================
// TMDB HELPER
// ============================================================
const tmdbCache = new Cache(5 * 60 * 1000);

async function tmdbFetch(endpoint, params = {}, retries = 3) {
    const url      = `https://api.themoviedb.org/3${endpoint}`;
    const allP     = { api_key: TMDB_API_KEY, ...params };
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;

    const cached = tmdbCache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const r = await axios.get(url, {
                params: allP,
                timeout: 12000,
                headers: { Accept: 'application/json', 'User-Agent': 'YOUFLEX/2.0' },
            });
            tmdbCache.set(cacheKey, r.data);
            return r.data;
        } catch (err) {
            console.error(`❌ TMDB attempt ${attempt} failed for ${endpoint}:`, err.message);
            if (attempt === retries) return { results: [] };
            await new Promise(r => setTimeout(r, attempt * 600));
        }
    }
}

// ============================================================
// YOUTUBE HELPER
// ============================================================
const ytCache = new Cache(5 * 60 * 1000);

async function youtubeFetch(endpoint, params = {}) {
    const url      = `https://www.googleapis.com/youtube/v3${endpoint}`;
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached   = ytCache.get(cacheKey);
    if (cached) return cached;
    const r = await axios.get(url, {
        params: { key: YOUTUBE_API_KEY, ...params },
        timeout: 10000,
    });
    ytCache.set(cacheKey, r.data);
    return r.data;
}

// ============================================================
// EMBED SOURCES (iframe-friendly, ordered by reliability)
// ============================================================
const EMBED_SOURCES = [
    {
        id:       'vidsrc_me',
        label:    'Source 1',
        movieUrl: (tmdb)       => `https://vidsrc.me/embed/movie?tmdb=${tmdb}`,
        tvUrl:    (tmdb, s, e) => `https://vidsrc.me/embed/tv?tmdb=${tmdb}&season=${s}&episode=${e}`,
    },
    {
        id:       'superembed',
        label:    'Source 2',
        movieUrl: (tmdb)       => `https://multiembed.mov/directstream.php?video_id=${tmdb}&tmdb=1`,
        tvUrl:    (tmdb, s, e) => `https://multiembed.mov/directstream.php?video_id=${tmdb}&tmdb=1&s=${s}&e=${e}`,
    },
    {
        id:       'smashystream',
        label:    'Source 3',
        movieUrl: (tmdb)       => `https://www.smashystream.xyz/playere.php?tmdb=${tmdb}`,
        tvUrl:    (tmdb, s, e) => `https://www.smashystream.xyz/playere.php?tmdb=${tmdb}&season=${s}&episode=${e}`,
    },
    {
        id:       '2embed',
        label:    'Source 4',
        movieUrl: (tmdb)       => `https://www.2embed.cc/embed/${tmdb}`,
        tvUrl:    (tmdb, s, e) => `https://www.2embed.cc/embedtv/${tmdb}&s=${s}&e=${e}`,
    },
    {
        id:       'vidsrc_to',
        label:    'Source 5',
        movieUrl: (tmdb)       => `https://vidsrc.to/embed/movie/${tmdb}`,
        tvUrl:    (tmdb, s, e) => `https://vidsrc.to/embed/tv/${tmdb}/${s}/${e}`,
    },
];

// ============================================================
// BUILD EMBED PAYLOAD (was missing — caused crash)
// ============================================================
function buildEmbedPayload(type, tmdbId, season, episode, src) {
    const embedUrl = type === 'tv'
        ? src.tvUrl(tmdbId, season, episode)
        : src.movieUrl(tmdbId);

    const allSources = EMBED_SOURCES.map(s => ({
        id:    s.id,
        label: s.label,
        url:   type === 'tv'
            ? s.tvUrl(tmdbId, season, episode)
            : s.movieUrl(tmdbId),
    }));

    return {
        embedUrl,
        sourceId:    src.id,
        sourceLabel: src.label,
        allSources,
        html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen; picture-in-picture"></iframe>`,
    };
}

// ============================================================
// TRAILER HELPERS
// ============================================================
async function getTrailerFromTMDB(type, id) {
    try {
        const data   = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];
        const order  = ['Trailer', 'Teaser', 'Clip', 'Featurette'];
        const sorted = videos
            .filter(v => v.site === 'YouTube')
            .sort((a, b) => {
                const ai = order.indexOf(a.type), bi = order.indexOf(b.type);
                if (ai !== bi) return ai - bi;
                return (b.official ? 1 : 0) - (a.official ? 1 : 0);
            });
        if (sorted.length) {
            return {
                success:  true,
                videoId:  sorted[0].key,
                site:     sorted[0].site,
                type:     sorted[0].type,
                name:     sorted[0].name,
                official: sorted[0].official,
            };
        }
        return { success: false };
    } catch {
        return { success: false };
    }
}

async function searchYouTubeTrailer(title, year, type = 'movie') {
    if (!YOUTUBE_API_KEY) return { success: false, message: 'YouTube API not configured' };

    const queries = year
        ? [
            `${title} ${year} official trailer`,
            `${title} ${year} trailer`,
            `${title} official trailer`,
          ]
        : [`${title} official trailer`, `${title} trailer`];

    if (type === 'tv') queries.push(`${title} series trailer`);

    const studios  = ['marvel','disney','netflix','hbo','apple','paramount','universal','warner','sony','20th century','lucasfilm','pixar','dreamworks','a24','lionsgate','mgm'];
    const penalties = ['review','reaction','explained','ending','breakdown','analysis','recap','spoiler'];

    for (const q of queries) {
        try {
            const data = await youtubeFetch('/search', {
                part: 'snippet', q, maxResults: 10,
                type: 'video', videoEmbeddable: 'true', order: 'relevance',
            });
            if (!data.items?.length) continue;

            const scored = data.items.map(item => {
                const tl = item.snippet.title.toLowerCase();
                const ch = item.snippet.channelTitle.toLowerCase();
                let score = 0;
                if (tl.includes('official')) score += 30;
                if (tl.includes('trailer'))  score += 20;
                if (tl.includes('teaser'))   score += 10;
                studios.forEach(s  => { if (ch.includes(s)) score += 20; });
                if (ch.includes('official')) score += 15;
                if (year && tl.includes(year)) score += 15;
                const words = title.toLowerCase().split(' ').filter(w => w.length > 3);
                if (words.length) score += (words.filter(w => tl.includes(w)).length / words.length) * 20;
                penalties.forEach(p => { if (tl.includes(p)) score -= 30; });
                return { ...item, score };
            }).sort((a, b) => b.score - a.score);

            const best = scored.find(r => r.score > 10);
            if (best) {
                return {
                    success:      true,
                    videoId:      best.id.videoId,
                    title:        best.snippet.title,
                    channelTitle: best.snippet.channelTitle,
                };
            }
        } catch (err) {
            console.error('YouTube search error:', err.message);
        }
    }
    return { success: false, message: 'No suitable trailer found' };
}

async function getTrailer(type, id) {
    const tmdb = await getTrailerFromTMDB(type, id);
    if (tmdb.success) return { ...tmdb, source: 'tmdb' };

    const details = await tmdbFetch(`/${type}/${id}`);
    const title   = details.title || details.name;
    if (!title) return { success: false, message: 'Title not found' };

    const year = details.release_date || details.first_air_date;
    const yt   = await searchYouTubeTrailer(
        title,
        year ? new Date(year).getFullYear().toString() : null,
        type,
    );

    if (yt.success) {
        return {
            success:      true,
            videoId:      yt.videoId,
            site:         'YouTube',
            type:         'Trailer',
            name:         yt.title,
            channelTitle: yt.channelTitle,
            source:       'youtube',
        };
    }
    return { success: false, message: 'No trailer found' };
}

// ============================================================
// ROOT
// ============================================================
app.get('/', (req, res) => res.json({
    name:         'YOUFLEX API',
    version:      '2.2.0',
    status:       'running',
    embedSources: EMBED_SOURCES.map(s => s.label),
    ytdlActive:   !!ytdl,
}));

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => res.json({
    status:    'OK',
    timestamp: new Date().toISOString(),
    ytdlActive: !!ytdl,
    cache:     Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.stats()])),
    services:  {
        tmdb:    { configured: !!TMDB_API_KEY },
        youtube: { configured: !!YOUTUBE_API_KEY },
    },
    environment: process.env.NODE_ENV || 'development',
}));

// ============================================================
// EMBED — MOVIE
// ============================================================
app.get('/api/embed/movie/:tmdbId',
    cacheMW(C.embed, r => `embed:movie:${r.params.tmdbId}:${r.query.source || 'vidsrc_me'}`),
    (req, res) => {
        const { tmdbId } = req.params;
        if (!tmdbId || !/^\d+$/.test(tmdbId))
            return res.status(400).json({ success: false, error: 'Invalid TMDB ID.' });

        const src = EMBED_SOURCES.find(s => s.id === req.query.source) || EMBED_SOURCES[0];
        res.json({
            success: true,
            data: {
                tmdbId,
                type: 'movie',
                ...buildEmbedPayload('movie', tmdbId, null, null, src),
            },
        });
    },
);

// ============================================================
// EMBED — TV
// ============================================================
app.get('/api/embed/tv/:tmdbId/:season/:episode',
    cacheMW(C.embed, r => `embed:tv:${r.params.tmdbId}:${r.params.season}:${r.params.episode}:${r.query.source || 'vidsrc_me'}`),
    (req, res) => {
        const { tmdbId, season, episode } = req.params;
        if (!tmdbId || !/^\d+$/.test(tmdbId))
            return res.status(400).json({ success: false, error: 'Invalid TMDB ID.' });

        const s = parseInt(season), e = parseInt(episode);
        if (isNaN(s) || isNaN(e) || s < 1 || e < 1)
            return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });

        const src = EMBED_SOURCES.find(x => x.id === req.query.source) || EMBED_SOURCES[0];
        res.json({
            success: true,
            data: {
                tmdbId,
                season: s,
                episode: e,
                type: 'tv',
                ...buildEmbedPayload('tv', tmdbId, s, e, src),
            },
        });
    },
);

// ============================================================
// EMBED — IMDB MOVIE (backward compat)
// ============================================================
app.get('/api/embed/movie/imdb/:imdbId',
    cacheMW(C.embed, r => `embed:movie:imdb:${r.params.imdbId}`),
    async (req, res) => {
        const { imdbId } = req.params;
        if (!imdbId || !/^tt\d+$/.test(imdbId))
            return res.status(400).json({ success: false, error: 'Invalid IMDB ID.' });

        const embedUrl = `https://vidsrc.me/embed/movie?imdb=${imdbId}`;
        res.json({
            success: true,
            data: {
                imdbId, type: 'movie', embedUrl,
                allSources: [{ id: 'vidsrc_me', label: 'Source 1', url: embedUrl }],
                html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`,
            },
        });
    },
);

// ============================================================
// EMBED — IMDB TV (backward compat)
// ============================================================
app.get('/api/embed/tv/imdb/:imdbId/:season/:episode',
    cacheMW(C.embed, r => `embed:tv:imdb:${r.params.imdbId}:${r.params.season}:${r.params.episode}`),
    async (req, res) => {
        const { imdbId, season, episode } = req.params;
        if (!imdbId || !/^tt\d+$/.test(imdbId))
            return res.status(400).json({ success: false, error: 'Invalid IMDB ID.' });

        const s = parseInt(season), e = parseInt(episode);
        if (isNaN(s) || isNaN(e))
            return res.status(400).json({ success: false, error: 'Invalid season/episode.' });

        try {
            const searchResult = await tmdbFetch('/find/' + imdbId, { external_source: 'imdb_id' });
            const results      = searchResult?.tv_results || [];
            if (results.length > 0) {
                const tmdbId   = results[0].id;
                const src      = EMBED_SOURCES[0];
                const embedUrl = src.tvUrl(tmdbId, s, e);
                return res.json({
                    success: true,
                    data: {
                        imdbId, tmdbId, season: s, episode: e, type: 'tv', embedUrl,
                        allSources: EMBED_SOURCES.map(x => ({ id: x.id, label: x.label, url: x.tvUrl(tmdbId, s, e) })),
                        html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`,
                    },
                });
            }
        } catch (error) {
            console.warn(`Could not convert IMDB ${imdbId} to TMDB:`, error.message);
        }

        const embedUrl = `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${s}&episode=${e}`;
        res.json({
            success: true,
            data: {
                imdbId, season: s, episode: e, type: 'tv', embedUrl,
                allSources: [{ id: 'vidsrc_me', label: 'Source 1', url: embedUrl }],
            },
        });
    },
);

// ============================================================
// EMBED — ALL SOURCES LIST
// ============================================================
app.get('/api/embed/sources/:type/:tmdbId', (req, res) => {
    const { type, tmdbId } = req.params;
    const { season = 1, episode = 1 } = req.query;

    if (!['movie', 'tv'].includes(type))
        return res.status(400).json({ success: false, error: 'type must be movie or tv' });
    if (!tmdbId || !/^\d+$/.test(tmdbId))
        return res.status(400).json({ success: false, error: 'Invalid TMDB ID' });

    const s = parseInt(season), e = parseInt(episode);
    const sources = EMBED_SOURCES.map(src => ({
        id:    src.id,
        label: src.label,
        url:   type === 'tv' ? src.tvUrl(tmdbId, s, e) : src.movieUrl(tmdbId),
    }));

    res.json({ success: true, data: { type, tmdbId, season: s, episode: e, sources } });
});

// ============================================================
// TV SEASON DETAILS
// ============================================================
app.get('/api/tv/:tvId/season/:season',
    cacheMW(C.seasons, r => `season:${r.params.tvId}:${r.params.season}`),
    async (req, res) => {
        const { tvId, season } = req.params;
        try {
            const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { episodes: [] } });
        }
    },
);

// ============================================================
// TV SERIES SEASONS LIST
// ============================================================
app.get('/api/tv/:tvId/seasons',
    cacheMW(C.seasons, r => `seasons:${r.params.tvId}`),
    async (req, res) => {
        const { tvId } = req.params;
        try {
            const details = await tmdbFetch(`/tv/${tvId}`);
            const seasons = (details.seasons || []).filter(s => s.season_number > 0);
            res.json({ success: true, data: { id: tvId, name: details.name, seasons } });
        } catch {
            res.json({ success: true, data: { seasons: [] } });
        }
    },
);

// ============================================================
// TRAILER
// ============================================================
app.get('/api/trailer/:type/:id',
    cacheMW(C.trailer, r => `trailer:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type))
            return res.status(400).json({ success: false, error: 'Type must be "movie" or "tv".' });
        if (!id || isNaN(parseInt(id)))
            return res.status(400).json({ success: false, error: 'ID must be a number.' });

        try {
            const result = await getTrailer(type, parseInt(id));
            if (result.success) {
                const vid = result.videoId;
                res.json({
                    success: true,
                    data: {
                        videoId:          vid,
                        site:             result.site         || 'YouTube',
                        type:             result.type         || 'Trailer',
                        name:             result.name         || 'Trailer',
                        official:         result.official     || false,
                        source:           result.source       || 'unknown',
                        channelTitle:     result.channelTitle || null,
                        embedUrl:         `https://www.youtube.com/embed/${vid}`,
                        embedUrlAutoplay: `https://www.youtube.com/embed/${vid}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
                        streamUrl:        ytdl ? `/api/stream/${vid}` : null,
                    },
                });
            } else {
                res.json({ success: false, error: result.message || 'No trailer found', data: null });
            }
        } catch (err) {
            console.error('Trailer error:', err.message);
            res.status(500).json({ success: false, error: 'Internal server error', data: null });
        }
    },
);

// ============================================================
// YOUTUBE SEARCH
// ============================================================
app.get('/api/youtube/search',
    cacheMW(C.youtube, r => `ytsearch:${r.query.q}:${r.query.maxResults || 5}`),
    async (req, res) => {
        const { q, maxResults = 5 } = req.query;
        if (!q)               return res.json({ success: false, error: 'Missing query', data: null });
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        try {
            const data  = await youtubeFetch('/search', {
                part: 'snippet', q, maxResults: parseInt(maxResults),
                type: 'video', videoEmbeddable: 'true',
            });
            const items = (data.items || []).map(i => ({
                id:           i.id.videoId,
                title:        i.snippet.title,
                channelTitle: i.snippet.channelTitle,
                thumbnail:    i.snippet.thumbnails?.medium?.url || '',
                publishedAt:  i.snippet.publishedAt,
            }));
            res.json({ success: true, data: { items } });
        } catch (err) {
            res.json({ success: false, error: err.message, data: null });
        }
    },
);

// ============================================================
// YOUTUBE VIDEO STATS
// ============================================================
app.get('/api/youtube/video/:id',
    cacheMW(C.youtube, r => `ytvideo:${r.params.id}`),
    async (req, res) => {
        const { id } = req.params;
        if (!YOUTUBE_API_KEY)
            return res.json({ success: false, error: 'YouTube API not configured', data: null });
        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id))
            return res.json({ success: false, error: 'Invalid video ID', data: null });
        try {
            const data  = await youtubeFetch('/videos', { part: 'statistics,snippet', id });
            const video = (data.items || [])[0];
            if (!video) return res.json({ success: false, error: 'Video not found', data: null });
            res.json({
                success: true,
                data: {
                    viewCount:    video.statistics?.viewCount,
                    likeCount:    video.statistics?.likeCount,
                    channelTitle: video.snippet?.channelTitle,
                    title:        video.snippet?.title,
                    publishedAt:  video.snippet?.publishedAt,
                },
            });
        } catch (err) {
            res.json({ success: false, error: err.message, data: null });
        }
    },
);

// ============================================================
// YTDL STREAM PROXY (optional)
// ============================================================
app.get('/api/stream/info/:videoId', async (req, res) => {
    if (!ytdl) return res.status(501).json({ success: false, error: 'ytdl-core not installed.' });
    const { videoId } = req.params;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid video ID.' });
    try {
        const info    = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const formats = info.formats
            .filter(f => f.hasVideo || f.hasAudio)
            .map(f => ({
                itag:          f.itag,
                quality:       f.qualityLabel || f.audioQuality || 'unknown',
                container:     f.container,
                mimeType:      f.mimeType,
                hasVideo:      f.hasVideo,
                hasAudio:      f.hasAudio,
                contentLength: f.contentLength,
                fps:           f.fps,
                bitrate:       f.bitrate,
            }))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        res.json({
            success: true,
            data: {
                videoId,
                title:     info.videoDetails.title,
                duration:  info.videoDetails.lengthSeconds,
                author:    info.videoDetails.author.name,
                viewCount: info.videoDetails.viewCount,
                thumbnail: info.videoDetails.thumbnails?.pop()?.url,
                formats,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/stream/:videoId', async (req, res) => {
    if (!ytdl) return res.status(501).json({ success: false, error: 'ytdl-core not installed.' });
    const { videoId } = req.params;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid YouTube video ID.' });

    const quality = req.query.quality || 'highestvideo';
    const ytUrl   = `https://www.youtube.com/watch?v=${videoId}`;
    try {
        const info   = await ytdl.getInfo(ytUrl);
        const format = ytdl.chooseFormat(info.formats, { quality });
        if (!format) return res.status(404).json({ success: false, error: 'No matching stream format.' });

        res.setHeader('Content-Type', format.mimeType || 'video/mp4');
        if (format.contentLength) res.setHeader('Content-Length', format.contentLength);
        res.setHeader('Accept-Ranges', 'bytes');

        const stream = ytdl(ytUrl, { format });
        stream.on('error', err => {
            console.error('ytdl stream error:', err.message);
            if (!res.headersSent) res.status(500).end();
        });
        stream.pipe(res);
    } catch (err) {
        console.error('ytdl error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// TRENDING
// ============================================================
app.get('/api/trending', cacheMW(C.trending), async (req, res) => {
    try {
        const [trending, upcoming, nowPlaying] = await Promise.all([
            tmdbFetch('/trending/all/day'),
            tmdbFetch('/movie/upcoming'),
            tmdbFetch('/movie/now_playing'),
        ]);

        const fmt = (items, cat, mt) =>
            (items || [])
                .filter(i => i.backdrop_path && i.media_type !== 'person')
                .slice(0, 4)
                .map(i => ({ ...i, media_type: mt || i.media_type || 'movie', heroCategory: cat }));

        res.json({
            success: true,
            data: [
                ...fmt(trending.results,   'trending'),
                ...fmt(upcoming.results,   'upcoming',    'movie'),
                ...fmt(nowPlaying.results, 'now-playing', 'movie'),
            ],
        });
    } catch (err) {
        console.error('Trending error:', err.message);
        res.json({ success: true, data: [] });
    }
});

// ============================================================
// CONTENT BROWSE
// ============================================================
app.get('/api/content/:category',
    cacheMW(C.details, r => `content:${r.params.category}:${JSON.stringify(r.query)}`),
    async (req, res) => {
        const { category } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;

        try {
            let endpoint = '/discover/movie';
            let params   = { page: parseInt(page), sort_by: sort };

            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year)       params['primary_release_year'] = parseInt(year);

            switch (category) {
                case 'trending':
                    endpoint = '/trending/all/week';
                    params   = { page: parseInt(page) };
                    break;
                case 'popular':
                    endpoint = '/discover/movie';
                    break;
                case 'tv':
                    endpoint = '/discover/tv';
                    break;
                case 'movie':
                    endpoint = '/discover/movie';
                    break;
                case 'upcoming':
                    endpoint = '/movie/upcoming';
                    params   = { page: parseInt(page) };
                    break;
                case 'now-playing':
                    endpoint = '/movie/now_playing';
                    params   = { page: parseInt(page) };
                    break;
                case 'top-rated':
                    endpoint = `/discover/${type}`;
                    params   = { ...params, 'vote_count.gte': 200 };
                    break;
                case 'anime':
                    endpoint = '/discover/tv';
                    params   = { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc', page: parseInt(page) };
                    break;
                case 'animation':
                    endpoint = '/discover/movie';
                    params   = { with_genres: 16, sort_by: 'popularity.desc', page: parseInt(page) };
                    break;
                default:
                    endpoint = '/discover/movie';
                    params   = { page: parseInt(page), sort_by: 'popularity.desc' };
            }

            const data = await tmdbFetch(endpoint, params);
            res.json({ success: true, data });
        } catch (err) {
            console.error('Content error:', err.message);
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    },
);

// ============================================================
// GENRE BROWSE
// ============================================================
app.get('/api/genre/:id',
    cacheMW(C.details, r => `genre:${r.params.id}:${JSON.stringify(r.query)}`),
    async (req, res) => {
        const { id } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            const params = { page: parseInt(page), sort_by: sort, with_genres: id };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year)       params[type === 'tv' ? 'first_air_date_year' : 'primary_release_year'] = parseInt(year);
            const data = await tmdbFetch(`/discover/${type}`, params);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    },
);

// ============================================================
// GENRES
// ============================================================
app.get('/api/genres/all', cacheMW(C.genres), async (req, res) => {
    try {
        const [mv, tv] = await Promise.all([
            tmdbFetch('/genre/movie/list'),
            tmdbFetch('/genre/tv/list'),
        ]);
        const merged = {};
        [...(mv.genres || []), ...(tv.genres || [])].forEach(g => { merged[g.id] = g.name; });
        res.json({ success: true, data: merged });
    } catch {
        res.json({ success: true, data: {} });
    }
});

app.get('/api/genres',
    cacheMW(C.genres, r => `genres:${r.query.type || 'movie'}`),
    async (req, res) => {
        const { type = 'movie' } = req.query;
        try {
            const data = await tmdbFetch(`/genre/${type}/list`);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { genres: [] } });
        }
    },
);

// ============================================================
// DETAILS
// ============================================================
app.get('/api/details/:type/:id',
    cacheMW(C.details, r => `details:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}`, {
                append_to_response: 'videos,images,credits,similar,watch/providers,external_ids',
            });
            res.json({ success: true, data });
        } catch {
            res.json({
                success: true,
                data: {
                    id: parseInt(id), title: 'Unavailable', name: 'Unavailable',
                    overview: "Couldn't load details.", poster_path: null, backdrop_path: null,
                    vote_average: 0, genres: [], credits: { cast: [] }, videos: { results: [] },
                },
            });
        }
    },
);

// ============================================================
// SEARCH
// ============================================================
app.get('/api/search',
    cacheMW(C.search, r => `search:${r.query.query}:${r.query.page || 1}`),
    async (req, res) => {
        const { query, page = 1 } = req.query;
        if (!query || query.length < 2)
            return res.json({ success: true, data: { results: [] } });
        try {
            const data = await tmdbFetch('/search/multi', { query, page: parseInt(page) });
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { results: [] } });
        }
    },
);

// ============================================================
// CREDITS
// ============================================================
app.get('/api/credits/:type/:id',
    cacheMW(C.credits, r => `credits:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/credits`);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { cast: [] } });
        }
    },
);

// ============================================================
// EPISODES
// ============================================================
app.get('/api/episodes/:tvId/:season',
    cacheMW(C.episodes, r => `episodes:${r.params.tvId}:${r.params.season}`),
    async (req, res) => {
        const { tvId, season } = req.params;
        try {
            const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { episodes: [] } });
        }
    },
);

// ============================================================
// PROVIDERS
// ============================================================
app.get('/api/providers/:type/:id',
    cacheMW(C.providers, r => `providers:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { results: {} } });
        }
    },
);

// ============================================================
// SIMILAR
// ============================================================
app.get('/api/similar/:type/:id',
    cacheMW(C.similar, r => `similar:${r.params.type}:${r.params.id}:${r.query.page || 1}`),
    async (req, res) => {
        const { type, id } = req.params;
        const { page = 1 } = req.query;
        try {
            const data = await tmdbFetch(`/${type}/${id}/similar`, { page: parseInt(page) });
            res.json({ success: true, data });
        } catch {
            res.json({ success: true, data: { results: [] } });
        }
    },
);

// ============================================================
// ENHANCED RECOMMENDATIONS
// ============================================================
async function computeScore(src, cand) {
    const sg = new Set((src.genre_ids  || (src.genres  || []).map(g => g.id)));
    const cg = new Set((cand.genre_ids || (cand.genres || []).map(g => g.id)));

    const unionSize = new Set([...sg, ...cg]).size;
    const genreScore  = (sg.size && unionSize) ? [...sg].filter(g => cg.has(g)).length / unionSize : 0;

    const srcY  = parseInt((src.release_date  || src.first_air_date  || '2000').split('-')[0]);
    const candY = parseInt((cand.release_date || cand.first_air_date || '2000').split('-')[0]);
    const yearScore   = Math.max(0, 1 - (Math.abs(srcY - candY) / 20));
    const ratingScore = Math.max(0, 1 - (Math.abs((src.vote_average || 5) - (cand.vote_average || 5)) / 5));
    const popScore    = Math.min(1, (cand.vote_count || 0) / 1000);

    return genreScore * 0.4 + yearScore * 0.2 + ratingScore * 0.2 + popScore * 0.2;
}

async function getEnhancedRecs(id, type) {
    const [src, sim, rec] = await Promise.all([
        tmdbFetch(`/${type}/${id}`),
        tmdbFetch(`/${type}/${id}/similar`),
        tmdbFetch(`/${type}/${id}/recommendations`),
    ]);

    const uniq = Array.from(
        new Map([
            ...(sim.results || []).slice(0, 20),
            ...(rec.results || []).slice(0, 20),
        ].map(i => [i.id, i])).values()
    ).filter(i => i.id !== id);

    const scored = await Promise.all(
        uniq.map(async i => ({ ...i, score: await computeScore(src, i), media_type: type }))
    );

    return {
        sourceId:        id,
        sourceType:      type,
        sourceTitle:     src.title || src.name,
        recommendations: scored.sort((a, b) => b.score - a.score).slice(0, 20),
    };
}

app.get('/api/recommendations/enhanced/:type/:id',
    cacheMW(C.recommendations, r => `erec:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await getEnhancedRecs(parseInt(id), type);
            res.json({ success: true, data });
        } catch (err) {
            res.json({ success: false, error: err.message, data: { recommendations: [] } });
        }
    },
);

// ============================================================
// YOUFLEX DOWNLOAD MODULE — WebTorrent approach
// ============================================================
const WebTorrent = require('webtorrent');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

// ── Single WebTorrent client instance ────────────────────────
let wtClient = null;
function getWtClient() {
    if (!wtClient) {
        wtClient = new WebTorrent();
        wtClient.on('error', err => console.error('WebTorrent error:', err.message));
    }
    return wtClient;
}

// ── Search YIFY for movies ────────────────────────────────────
async function searchYIFY(tmdbId, quality = '720p') {
    try {
        // Get movie details from TMDB first
        const details = await tmdbFetch(`/movie/${tmdbId}`);
        const title = details.title;
        const year = details.release_date?.split('-')[0];

        if (!title) return null;

        console.log(`🔍 Searching YIFY for: ${title} (${year})`);

        const searchUrl = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(title)}&quality=${quality}&limit=5`;
        const res = await axios.get(searchUrl, { timeout: 10000 });
        const movies = res.data?.data?.movies || [];

        // Find best match by year
        const match = movies.find(m => 
            m.year == year || 
            m.title.toLowerCase().includes(title.toLowerCase())
        ) || movies[0];

        if (!match) return null;

        // Get preferred quality torrent
        const torrents = match.torrents || [];
        const torrent = torrents.find(t => t.quality === quality)
            || torrents.find(t => t.quality === '720p')
            || torrents[0];

        if (!torrent) return null;

        console.log(`✅ Found: ${match.title} (${match.year}) — ${torrent.quality}`);
        return {
            title: match.title,
            year: match.year,
            quality: torrent.quality,
            magnet: `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(match.title)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://torrent.gresille.org:80/announce&tr=udp://p4p.arenabg.com:1337&tr=udp://tracker.leechers-paradise.org:6969`,
            size: torrent.size,
            seeds: torrent.seeds,
        };
    } catch (err) {
        console.error('YIFY search error:', err.message);
        return null;
    }
}

// ── Search EZTV for TV shows ──────────────────────────────────
async function searchEZTV(tmdbId, season, episode) {
    try {
        const details = await tmdbFetch(`/tv/${tmdbId}`);
        const title = details.name;
        const imdbId = details.external_ids?.imdb_id;

        if (!title) return null;

        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');

        console.log(`🔍 Searching EZTV for: ${title} S${s}E${e}`);

        // Try EZTV API
        let searchUrl = imdbId
            ? `https://eztv.re/api/get-torrents?imdb_id=${imdbId.replace('tt','')}&limit=10`
            : `https://eztv.re/api/get-torrents?limit=10`;

        const res = await axios.get(searchUrl, { timeout: 10000 });
        const torrents = res.data?.torrents || [];

        // Filter for specific episode
        const epMatch = torrents.filter(t => {
            const tn = t.title?.toLowerCase() || '';
            return tn.includes(`s${s}e${e}`) || tn.includes(`${season}x${e}`);
        });

        const torrent = epMatch.find(t => t.title?.includes('720p'))
            || epMatch.find(t => t.title?.includes('1080p'))
            || epMatch[0];

        if (!torrent) {
            // Fallback: search by title
            const fallbackUrl = `https://eztv.re/api/get-torrents?limit=10`;
            return null;
        }

        console.log(`✅ Found: ${torrent.title}`);
        return {
            title: torrent.title,
            magnet: torrent.magnet_url,
            size: torrent.size_bytes,
            seeds: torrent.seeds,
        };
    } catch (err) {
        console.error('EZTV search error:', err.message);
        return null;
    }
}

// ── Stream torrent to browser ─────────────────────────────────
function streamTorrent(magnetUrl, filename, res, req) {
    return new Promise((resolve, reject) => {
        const client = getWtClient();
        const downloadId = Date.now().toString();

        console.log(`🧲 Adding torrent: ${magnetUrl.slice(0, 60)}...`);

        const timeout = setTimeout(() => {
            reject(new Error('Torrent timeout — no peers found'));
        }, 60000); // 60 second timeout

        client.add(magnetUrl, { path: os.tmpdir() }, torrent => {
            clearTimeout(timeout);

            // Find the largest video file
            const file = torrent.files.reduce((a, b) =>
                a.size > b.size ? a : b
            );

            console.log(`📦 Streaming: ${file.name} (${(file.length / 1024 / 1024).toFixed(0)}MB)`);

            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Content-Length', file.length);
            res.setHeader('Accept-Ranges', 'bytes');

            const stream = file.createReadStream();

            stream.on('error', err => {
                console.error('Stream error:', err.message);
                torrent.destroy();
                reject(err);
            });

            stream.pipe(res);

            res.on('close', () => {
                console.log(`🔌 Client disconnected — destroying torrent`);
                torrent.destroy();
                resolve();
            });

            res.on('finish', () => {
                console.log(`✅ Torrent stream complete`);
                torrent.destroy();
                resolve();
            });

            // Log download progress
            const progressInterval = setInterval(() => {
                const progress = (torrent.progress * 100).toFixed(1);
                const speed = (torrent.downloadSpeed / 1024).toFixed(0);
                console.log(`📥 Progress: ${progress}% — ${speed} KB/s — Peers: ${torrent.numPeers}`);
                if (torrent.done) clearInterval(progressInterval);
            }, 5000);
        });

        client.on('error', err => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// ============================================================
// GET /api/download/status
// ============================================================
app.get('/api/download/status', (req, res) => {
    res.json({
        success: true,
        data: {
            ytdlCore:   !!ytdl,
            ytDlp:      true,
            webTorrent: true,
            activeJobs: wtClient ? wtClient.torrents.length : 0,
            features: {
                trailerDownload: !!ytdl,
                movieDownload:   true,
                tvDownload:      true,
            },
        },
    });
});

// ============================================================
// GET /api/download/trailer/:videoId
// ============================================================
app.get('/api/download/trailer/:videoId', async (req, res) => {
    if (!ytdl)
        return res.status(503).json({ success: false, error: 'ytdl-core not installed.' });

    const { videoId } = req.params;
    const { title = 'trailer' } = req.query;

    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid YouTube video ID' });

    const filename = (title || 'trailer').replace(/[^\w\s\-]/g, '').replace(/\s+/g, '_').slice(0, 80) + '_trailer.mp4';
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`⬇️  Trailer: ${filename}`);

    try {
        const info = await ytdl.getInfo(ytUrl);
        const format = ytdl.chooseFormat(info.formats, {
            quality: 'highestvideo',
            filter: f => f.container === 'mp4' && f.hasAudio,
        }) || ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });

        if (!format)
            return res.status(404).json({ success: false, error: 'No format found' });

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (format.contentLength) res.setHeader('Content-Length', format.contentLength);

        const stream = ytdl(ytUrl, { format });
        stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
        stream.pipe(res);
        req.on('close', () => stream.destroy());
    } catch (err) {
        if (!res.headersSent)
            res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// GET /api/download/:type/:tmdbId
// ============================================================
app.get('/api/download/:type/:tmdbId', async (req, res) => {
    const { type, tmdbId } = req.params;

    if (type === 'trailer')
        return res.status(404).json({ success: false, error: 'Use /api/download/trailer/:videoId' });

    if (!['movie', 'tv'].includes(type))
        return res.status(400).json({ success: false, error: 'type must be movie or tv' });

    const {
        season  = 1,
        episode = 1,
        quality = '720p',
        title   = 'video',
    } = req.query;

    console.log(`⬇️  Download request: ${type} ${tmdbId} S${season}E${episode}`);

    try {
        let torrentInfo = null;

        if (type === 'movie') {
            torrentInfo = await searchYIFY(tmdbId, quality === 'best' ? '720p' : quality);
        } else {
            torrentInfo = await searchEZTV(tmdbId, parseInt(season), parseInt(episode));
        }

        if (!torrentInfo || !torrentInfo.magnet) {
            return res.status(404).json({
                success: false,
                error: `No torrent found for this ${type}. Try a different title.`
            });
        }

        const filename = (torrentInfo.title || title)
            .replace(/[^\w\s\-]/g, '')
            .replace(/\s+/g, '_')
            .slice(0, 80) + '.mp4';

        console.log(`🧲 Torrent found: ${torrentInfo.title} — Seeds: ${torrentInfo.seeds}`);

        await streamTorrent(torrentInfo.magnet, filename, res, req);

    } catch (err) {
        console.error('Download error:', err.message);
        if (!res.headersSent)
            res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// DELETE /api/download/cancel/:downloadId
// ============================================================
app.delete('/api/download/cancel/:downloadId', (req, res) => {
    res.json({ success: true, message: 'Use the browser stop button to cancel downloads.' });
});

// ============================================================
// 404 HANDLER
// ============================================================
app.use((req, res) => {
    res.status(404).json({ success: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ============================================================
// ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend v2.2 running on port ${PORT}`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s => s.label).join(', ')}`);
    console.log(`📺 TV:      GET /api/embed/tv/:tmdbId/:season/:episode`);
    console.log(`🎥 Movie:   GET /api/embed/movie/:tmdbId`);
    console.log(`📋 Sources: GET /api/embed/sources/:type/:tmdbId`);
    console.log(`🔀 Stream:  ${ytdl ? 'GET /api/stream/:videoId ✅' : '❌ ytdl not installed'}`);
    console.log(`❤️  Health:  GET /api/health\n`);
});
