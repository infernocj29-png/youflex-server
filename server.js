const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

// ── ytdl-core (optional — only used for /api/stream/* routes) ──
let ytdl = null;
try {
    ytdl = require('@distube/ytdl-core');
    console.log('✅ ytdl-core loaded — /api/stream/* routes active');
} catch (_) {
    console.warn('⚠️  ytdl-core not installed — stream proxy disabled. Run: npm install @distube/ytdl-core');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// API KEYS
// ============================================================
const TMDB_API_KEY    = process.env.TMDB_API_KEY    || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting…');
console.log(`📡 TMDB API:    ${TMDB_API_KEY    ? '✅ Configured' : '❌ Missing'}`);
console.log(`📡 YouTube API: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Missing'}`);

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
        console.log('⚠️  CORS request from unknown origin:', origin);
        cb(null, true);
    },
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json());

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
        for (const [, e] of this.store) { total++; if (Date.now()-e.ts > this.ttl) expired++; }
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
        if (cached) { res.setHeader('X-Cache','HIT'); return res.json(cached); }
        const orig = res.json.bind(res);
        res.json = data => { cache.set(key, data); res.setHeader('X-Cache','MISS'); orig(data); };
        next();
    };
}

// ============================================================
// TMDB HELPER
// ============================================================
const tmdbCache = new Cache(5 * 60 * 1000);

async function tmdbFetch(endpoint, params = {}, retries = 2) {
    const url      = `https://api.themoviedb.org/3${endpoint}`;
    const allP     = { api_key: TMDB_API_KEY, ...params };
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;

    const cached = tmdbCache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const r = await axios.get(url, {
                params: allP, timeout: 10000,
                headers: { Accept: 'application/json', 'User-Agent': 'YOUFLEX/2.0' },
            });
            tmdbCache.set(cacheKey, r.data);
            return r.data;
        } catch (err) {
            console.error(`❌ TMDB attempt ${attempt} failed for ${endpoint}:`, err.message);
            if (attempt === retries) return { results: [] };
            await new Promise(r => setTimeout(r, attempt * 500));
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
    const r = await axios.get(url, { params: { key: YOUTUBE_API_KEY, ...params }, timeout: 10000 });
    ytCache.set(cacheKey, r.data);
    return r.data;
}

// ============================================================
// VIDSRC EMBED SOURCES (ordered by reliability)
// ============================================================
const EMBED_SOURCES = [
    {
        id: 'vidsrc_xyz',
        label: 'VidSrc.xyz',
        movieUrl:  (tmdb) => `https://vidsrc.xyz/embed/movie?tmdb=${tmdb}`,
        tvUrl:     (tmdb, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${tmdb}&season=${s}&episode=${e}`,
    },
    {
        id: 'embedsu',
        label: 'Embed.su',
        movieUrl:  (tmdb) => `https://embed.su/embed/movie/${tmdb}`,
        tvUrl:     (tmdb, s, e) => `https://embed.su/embed/tv/${tmdb}/${s}/${e}`,
    },
    {
        id: 'vidsrc_to',
        label: 'VidSrc.to',
        movieUrl:  (tmdb) => `https://vidsrc.to/embed/movie/${tmdb}`,
        tvUrl:     (tmdb, s, e) => `https://vidsrc.to/embed/tv/${tmdb}/${s}/${e}`,
    },
    {
        id: 'vidsrc_me',
        label: 'VidSrc.me',
        movieUrl:  (tmdb) => `https://vidsrc.me/embed/movie?tmdb=${tmdb}`,
        tvUrl:     (tmdb, s, e) => `https://vidsrc.me/embed/tv?tmdb=${tmdb}&season=${s}&episode=${e}`,
    },
    {
        id: 'superembed',
        label: 'SuperEmbed',
        movieUrl:  (tmdb) => `https://multiembed.mov/directstream.php?video_id=${tmdb}&tmdb=1`,
        tvUrl:     (tmdb, s, e) => `https://multiembed.mov/directstream.php?video_id=${tmdb}&tmdb=1&s=${s}&e=${e}`,
    },
];

// ============================================================
// TRAILER SYSTEM (unchanged)
// ============================================================
async function getTrailerFromTMDB(type, id) {
    try {
        const data   = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];
        const order  = ['Trailer','Teaser','Clip','Featurette'];
        const sorted = videos
            .filter(v => v.site === 'YouTube')
            .sort((a, b) => {
                const ai = order.indexOf(a.type), bi = order.indexOf(b.type);
                if (ai !== bi) return ai - bi;
                return (b.official ? 1 : 0) - (a.official ? 1 : 0);
            });
        if (sorted.length)
            return { success: true, videoId: sorted[0].key, site: sorted[0].site, type: sorted[0].type, name: sorted[0].name, official: sorted[0].official };
        return { success: false };
    } catch { return { success: false }; }
}

async function searchYouTubeTrailer(title, year, type = 'movie') {
    if (!YOUTUBE_API_KEY) return { success: false, message: 'YouTube API not configured' };
    const queries = year
        ? [`${title} ${year} official trailer`, `${title} ${year} trailer`, `${title} official trailer`]
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
                const tl = item.snippet.title.toLowerCase(), ch = item.snippet.channelTitle.toLowerCase();
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
            if (best) return { success: true, videoId: best.id.videoId, title: best.snippet.title, channelTitle: best.snippet.channelTitle };
        } catch(err) { console.error('YouTube search error:', err.message); }
    }
    return { success: false, message: 'No suitable trailer found' };
}

async function getTrailer(type, id) {
    const tmdb = await getTrailerFromTMDB(type, id);
    if (tmdb.success) return { ...tmdb, source: 'tmdb' };

    const details = await tmdbFetch(`/${type}/${id}`);
    const title   = details.title || details.name;
    if (!title) return { success: false, message: 'Title not found' };

    const year  = details.release_date || details.first_air_date;
    const yt    = await searchYouTubeTrailer(title, year ? new Date(year).getFullYear().toString() : null, type);
    if (yt.success) return { success: true, videoId: yt.videoId, site: 'YouTube', type: 'Trailer', name: yt.title, channelTitle: yt.channelTitle, source: 'youtube' };
    return { success: false, message: 'No trailer found' };
}

// ============================================================
// ROOT
// ============================================================
app.get('/', (req, res) => res.json({
    name: 'YOUFLEX API', version: '2.1.0', status: 'running',
    embedSources: EMBED_SOURCES.map(s => s.id),
    ytdlActive: !!ytdl,
}));

// ============================================================
// HEALTH
// ============================================================
app.get('/api/health', (req, res) => res.json({
    status: 'OK', timestamp: new Date().toISOString(),
    ytdlActive: !!ytdl,
    cache: Object.fromEntries(Object.entries(C).map(([k,v]) => [k, v.stats()])),
    services: { tmdb: { configured: !!TMDB_API_KEY }, youtube: { configured: !!YOUTUBE_API_KEY } },
    environment: process.env.NODE_ENV || 'development',
}));

// ============================================================
// EMBED — MOVIE (TMDB ID)
// ============================================================
app.get('/api/embed/movie/:tmdbId',
    cacheMW(C.embed, r => `embed:movie:${r.params.tmdbId}:${r.query.source||'vidsrc_me'}`),
    (req, res) => {
        const { tmdbId } = req.params;
        if (!tmdbId || !/^\d+$/.test(tmdbId))
            return res.status(400).json({ success: false, error: 'Invalid TMDB ID.' });
        const src = EMBED_SOURCES.find(s => s.id === req.query.source) || EMBED_SOURCES[0];
        res.json({ success: true, data: { tmdbId, type: 'movie', ...buildEmbedPayload('movie', tmdbId, null, null, src) } });
    }
);

// ============================================================
// EMBED — TV (TMDB ID + season + episode)
// ============================================================
app.get('/api/embed/tv/:tmdbId/:season/:episode',
    cacheMW(C.embed, r => `embed:tv:${r.params.tmdbId}:${r.params.season}:${r.params.episode}:${r.query.source||'vidsrc_me'}`),
    (req, res) => {
        const { tmdbId, season, episode } = req.params;
        if (!tmdbId || !/^\d+$/.test(tmdbId))
            return res.status(400).json({ success: false, error: 'Invalid TMDB ID.' });
        const s = parseInt(season), e = parseInt(episode);
        if (isNaN(s) || isNaN(e) || s < 1 || e < 1)
            return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });
        const src = EMBED_SOURCES.find(x => x.id === req.query.source) || EMBED_SOURCES[0];
        res.json({ success: true, data: { tmdbId, season: s, episode: e, type: 'tv', ...buildEmbedPayload('tv', tmdbId, s, e, src) } });
    }
);

// ============================================================
// EMBED — MOVIE (IMDB ID) - KEPT FOR BACKWARD COMPATIBILITY
// ============================================================
app.get('/api/embed/movie/imdb/:imdbId',
    cacheMW(C.embed, r => `embed:movie:imdb:${r.params.imdbId}`),
    async (req, res) => {
        const { imdbId } = req.params;
        if (!imdbId || !/^tt\d+$/.test(imdbId))
            return res.status(400).json({ success: false, error: 'Invalid IMDB ID.' });
        const embedUrl = `https://vidsrc.me/embed/movie?imdb=${imdbId}`;
        res.json({ success: true, data: { imdbId, type: 'movie', embedUrl, html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>` } });
    }
);

// ============================================================
// EMBED — TV (IMDB ID) - UPDATED TO USE TMDB ID INTERNALLY
// ============================================================
app.get('/api/embed/tv/imdb/:imdbId/:season/:episode',
    cacheMW(C.embed, r => `embed:tv:imdb:${r.params.imdbId}:${r.params.season}:${r.params.episode}`),
    async (req, res) => {
        const { imdbId, season, episode } = req.params;
        if (!imdbId || !/^tt\d+$/.test(imdbId))
            return res.status(400).json({ success: false, error: 'Invalid IMDB ID.' });
        const s = parseInt(season), e = parseInt(episode);
        if (isNaN(s) || isNaN(e)) return res.status(400).json({ success: false, error: 'Invalid season/episode.' });
        
        // Try to get TMDB ID from IMDB ID
        try {
            // Try to find the TMDB ID by searching
            const searchResult = await tmdbFetch('/find/' + imdbId, { external_source: 'imdb_id' });
            const results = searchResult?.tv_results || [];
            
            if (results.length > 0) {
                const tmdbId = results[0].id;
                // Use the TMDB-based embed URL
                const embedUrl = `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${s}&episode=${e}`;
                return res.json({ 
                    success: true, 
                    data: { 
                        imdbId, 
                        tmdbId,
                        season: s, 
                        episode: e, 
                        type: 'tv', 
                        embedUrl,
                        html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe>`
                    } 
                });
            }
        } catch (error) {
            console.warn(`Could not convert IMDB ID ${imdbId} to TMDB ID:`, error.message);
        }

        // Fallback: Use IMDB-based URL directly (less reliable but works sometimes)
        const embedUrl = `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${s}&episode=${e}`;
        res.json({ success: true, data: { imdbId, season: s, episode: e, type: 'tv', embedUrl } });
    }
);

// ============================================================
// EMBED — ALL SOURCES LIST
// ============================================================
app.get('/api/embed/sources/:type/:tmdbId', (req, res) => {
    const { type, tmdbId } = req.params;
    const { season = 1, episode = 1 } = req.query;
    if (!['movie','tv'].includes(type))
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
    }
);

// ============================================================
// TV SERIES FULL DETAILS
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
    }
);

// ============================================================
// YTDL STREAM PROXY
// ============================================================
app.get('/api/stream/:videoId', async (req, res) => {
    if (!ytdl) return res.status(501).json({ success: false, error: 'ytdl-core not installed on this server. Run: npm install @distube/ytdl-core' });

    const { videoId } = req.params;
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId))
        return res.status(400).json({ success: false, error: 'Invalid YouTube video ID.' });

    const quality = req.query.quality || 'highestvideo';
    const ytUrl   = `https://www.youtube.com/watch?v=${videoId}`;

    try {
        const info   = await ytdl.getInfo(ytUrl);
        const format = ytdl.chooseFormat(info.formats, { quality });
        if (!format) return res.status(404).json({ success: false, error: 'No matching stream format found.' });

        res.setHeader('Content-Type', format.mimeType || 'video/mp4');
        if (format.contentLength) res.setHeader('Content-Length', format.contentLength);
        res.setHeader('Accept-Ranges', 'bytes');

        const stream = ytdl(ytUrl, { format });
        stream.on('error', err => { console.error('ytdl stream error:', err.message); if (!res.headersSent) res.status(500).end(); });
        stream.pipe(res);
    } catch (err) {
        console.error('ytdl error:', err.message);
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
});

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
                title:       info.videoDetails.title,
                duration:    info.videoDetails.lengthSeconds,
                author:      info.videoDetails.author.name,
                viewCount:   info.videoDetails.viewCount,
                thumbnail:   info.videoDetails.thumbnails?.pop()?.url,
                formats,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// TRAILER ENDPOINT
// ============================================================
app.get('/api/trailer/:type/:id',
    cacheMW(C.trailer, r => `trailer:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        if (!['movie','tv'].includes(type)) return res.status(400).json({ success: false, error: 'Type must be "movie" or "tv".' });
        if (!id || isNaN(parseInt(id)))    return res.status(400).json({ success: false, error: 'ID must be a number.' });
        try {
            const result = await getTrailer(type, parseInt(id));
            if (result.success) {
                const vid = result.videoId;
                res.json({ success: true, data: {
                    videoId:          vid,
                    site:             result.site          || 'YouTube',
                    type:             result.type          || 'Trailer',
                    name:             result.name          || 'Trailer',
                    official:         result.official      || false,
                    source:           result.source        || 'unknown',
                    channelTitle:     result.channelTitle  || null,
                    embedUrl:         `https://www.youtube.com/embed/${vid}`,
                    embedUrlAutoplay: `https://www.youtube.com/embed/${vid}?autoplay=1&rel=0&modestbranding=1&playsinline=1`,
                    streamUrl:        ytdl ? `/api/stream/${vid}` : null,
                }});
            } else {
                res.json({ success: false, error: result.message || 'No trailer found', data: null });
            }
        } catch (err) {
            res.status(500).json({ success: false, error: 'Internal server error', data: null });
        }
    }
);

// ============================================================
// YOUTUBE ENDPOINTS (unchanged)
// ============================================================
app.get('/api/youtube/search',
    cacheMW(C.youtube, r => `ytsearch:${r.query.q}:${r.query.maxResults||5}`),
    async (req, res) => {
        const { q, maxResults = 5 } = req.query;
        if (!q)               return res.json({ success: false, error: 'Missing query', data: null });
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        try {
            const data  = await youtubeFetch('/search', { part: 'snippet', q, maxResults: parseInt(maxResults), type: 'video', videoEmbeddable: 'true' });
            const items = (data.items || []).map(i => ({
                id: i.id.videoId, title: i.snippet.title,
                channelTitle: i.snippet.channelTitle,
                thumbnail: i.snippet.thumbnails?.medium?.url || '',
                publishedAt: i.snippet.publishedAt,
            }));
            res.json({ success: true, data: { items } });
        } catch (err) { res.json({ success: false, error: err.message, data: null }); }
    }
);

app.get('/api/youtube/video/:id',
    cacheMW(C.youtube, r => `ytvideo:${r.params.id}`),
    async (req, res) => {
        const { id } = req.params;
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return res.json({ success: false, error: 'Invalid video ID', data: null });
        try {
            const data  = await youtubeFetch('/videos', { part: 'statistics,snippet', id });
            const video = (data.items || [])[0];
            if (!video) return res.json({ success: false, error: 'Video not found', data: null });
            res.json({ success: true, data: {
                viewCount:    video.statistics?.viewCount,
                likeCount:    video.statistics?.likeCount,
                channelTitle: video.snippet?.channelTitle,
                title:        video.snippet?.title,
                publishedAt:  video.snippet?.publishedAt,
            }});
        } catch (err) { res.json({ success: false, error: err.message, data: null }); }
    }
);

// ============================================================
// TMDB ENDPOINTS (unchanged)
// ============================================================
app.get('/api/trending', cacheMW(C.trending), async (req, res) => {
    try {
        const [trending, upcoming, nowPlaying] = await Promise.all([
            tmdbFetch('/trending/all/day'),
            tmdbFetch('/movie/upcoming'),
            tmdbFetch('/movie/now_playing'),
        ]);
        const fmt = (items, cat, mt) =>
            (items || []).filter(i => i.backdrop_path && i.media_type !== 'person').slice(0,4)
                         .map(i => ({ ...i, media_type: mt || i.media_type || 'movie', heroCategory: cat }));
        res.json({ success: true, data: [
            ...fmt(trending.results,   'trending'),
            ...fmt(upcoming.results,   'upcoming',    'movie'),
            ...fmt(nowPlaying.results, 'now-playing', 'movie'),
        ]});
    } catch { res.json({ success: true, data: [] }); }
});

app.get('/api/content/:category',
    cacheMW(C.details, r => `content:${r.params.category}:${JSON.stringify(r.query)}`),
    async (req, res) => {
        const { category } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            let endpoint = '/discover/movie', params = { page: parseInt(page), sort_by: sort };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year)       params['primary_release_year'] = parseInt(year);
            switch (category) {
                case 'trending':    endpoint = '/trending/all/week'; params = { page: parseInt(page) }; break;
                case 'popular':     endpoint = '/discover/movie'; break;
                case 'tv':          endpoint = '/discover/tv'; break;
                case 'movie':       endpoint = '/discover/movie'; break;
                case 'upcoming':    endpoint = '/movie/upcoming'; params = { page: parseInt(page) }; break;
                case 'now-playing': endpoint = '/movie/now_playing'; params = { page: parseInt(page) }; break;
                case 'top-rated':   endpoint = `/discover/${type}`; params = { ...params, 'vote_count.gte': 200 }; break;
                case 'anime':       endpoint = '/discover/tv'; params = { with_genres:16, with_original_language:'ja', sort_by:'popularity.desc', page:parseInt(page) }; break;
                case 'animation':   endpoint = '/discover/movie'; params = { with_genres:16, sort_by:'popularity.desc', page:parseInt(page) }; break;
                default:            endpoint = '/discover/movie'; params = { page:parseInt(page), sort_by:'popularity.desc' };
            }
            const data = await tmdbFetch(endpoint, params);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { results:[], page:1, total_pages:0 } }); }
    }
);

app.get('/api/genre/:id',
    cacheMW(C.details, r => `genre:${r.params.id}:${JSON.stringify(r.query)}`),
    async (req, res) => {
        const { id } = req.params;
        const { page=1, sort='popularity.desc', rating=0, year='', type='movie' } = req.query;
        try {
            const params = { page:parseInt(page), sort_by:sort, with_genres:id };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year)       params[type==='tv' ? 'first_air_date_year' : 'primary_release_year'] = parseInt(year);
            const data = await tmdbFetch(`/discover/${type}`, params);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { results:[], page:1, total_pages:0 } }); }
    }
);

app.get('/api/genres/all', cacheMW(C.genres), async (req, res) => {
    try {
        const [mv, tv] = await Promise.all([tmdbFetch('/genre/movie/list'), tmdbFetch('/genre/tv/list')]);
        const merged = {};
        [...(mv.genres||[]),...(tv.genres||[])].forEach(g => { merged[g.id] = g.name; });
        res.json({ success: true, data: merged });
    } catch { res.json({ success: true, data: {} }); }
});

app.get('/api/genres',
    cacheMW(C.genres, r => `genres:${r.query.type||'movie'}`),
    async (req, res) => {
        const { type='movie' } = req.query;
        try {
            const data = await tmdbFetch(`/genre/${type}/list`);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { genres:[] } }); }
    }
);

app.get('/api/details/:type/:id',
    cacheMW(C.details, r => `details:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}`, { append_to_response:'videos,images,credits,similar,watch/providers,external_ids' });
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { id:parseInt(id), title:'Unavailable', name:'Unavailable', overview:"Couldn't load details.", poster_path:null, backdrop_path:null, vote_average:0, genres:[], credits:{cast:[]}, videos:{results:[]} } }); }
    }
);

app.get('/api/search',
    cacheMW(C.search, r => `search:${r.query.query}:${r.query.page||1}`),
    async (req, res) => {
        const { query, page=1 } = req.query;
        if (!query || query.length < 2) return res.json({ success: true, data: { results:[] } });
        try {
            const data = await tmdbFetch('/search/multi', { query, page:parseInt(page) });
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { results:[] } }); }
    }
);

app.get('/api/credits/:type/:id',
    cacheMW(C.credits, r => `credits:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/credits`);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { cast:[] } }); }
    }
);

app.get('/api/episodes/:tvId/:season',
    cacheMW(C.episodes, r => `episodes:${r.params.tvId}:${r.params.season}`),
    async (req, res) => {
        const { tvId, season } = req.params;
        try {
            const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { episodes:[] } }); }
    }
);

app.get('/api/providers/:type/:id',
    cacheMW(C.providers, r => `providers:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { results:{} } }); }
    }
);

app.get('/api/similar/:type/:id',
    cacheMW(C.similar, r => `similar:${r.params.type}:${r.params.id}:${r.query.page||1}`),
    async (req, res) => {
        const { type, id } = req.params;
        const { page=1 } = req.query;
        try {
            const data = await tmdbFetch(`/${type}/${id}/similar`, { page:parseInt(page) });
            res.json({ success: true, data });
        } catch { res.json({ success: true, data: { results:[] } }); }
    }
);

// ============================================================
// ENHANCED RECOMMENDATIONS (unchanged)
// ============================================================
async function computeScore(src, cand) {
    const sg = new Set((src.genre_ids  || (src.genres  ||[]).map(g=>g.id)));
    const cg = new Set((cand.genre_ids || (cand.genres ||[]).map(g=>g.id)));
    const genreScore   = sg.size ? [...sg].filter(g=>cg.has(g)).length / new Set([...sg,...cg]).size : 0;
    const srcY  = parseInt((src.release_date  || src.first_air_date  || '2000').split('-')[0]);
    const candY = parseInt((cand.release_date || cand.first_air_date || '2000').split('-')[0]);
    const yearScore    = Math.max(0, 1-(Math.abs(srcY-candY)/20));
    const ratingScore  = Math.max(0, 1-(Math.abs((src.vote_average||5)-(cand.vote_average||5))/5));
    const popScore     = Math.min(1, (cand.vote_count||0)/1000);
    return genreScore*0.4 + yearScore*0.2 + ratingScore*0.2 + popScore*0.2;
}

async function getEnhancedRecs(id, type) {
    const [src, sim, rec] = await Promise.all([
        tmdbFetch(`/${type}/${id}`),
        tmdbFetch(`/${type}/${id}/similar`),
        tmdbFetch(`/${type}/${id}/recommendations`),
    ]);
    const uniq = Array.from(new Map([...(sim.results||[]).slice(0,20),...(rec.results||[]).slice(0,20)].map(i=>[i.id,i])).values()).filter(i=>i.id!==id);
    const scored = await Promise.all(uniq.map(async i => ({ ...i, score: await computeScore(src, i), media_type: type })));
    return { sourceId:id, sourceType:type, sourceTitle:src.title||src.name, recommendations: scored.sort((a,b)=>b.score-a.score).slice(0,20) };
}

app.get('/api/recommendations/enhanced/:type/:id',
    cacheMW(C.recommendations, r => `erec:${r.params.type}:${r.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await getEnhancedRecs(parseInt(id), type);
            res.json({ success: true, data });
        } catch (err) {
            res.json({ success: false, error: err.message, data: { recommendations:[] } });
        }
    }
);

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend v2.1 running on port ${PORT}`);
    console.log(`🎬 Embed sources: ${EMBED_SOURCES.map(s=>s.label).join(', ')}`);
    console.log(`📺 TV embed:  GET /api/embed/tv/:tmdbId/:season/:episode`);
    console.log(`🎥 Movie embed: GET /api/embed/movie/:tmdbId`);
    console.log(`📋 All sources: GET /api/embed/sources/:type/:tmdbId`);
    console.log(`🔀 ytdl stream: ${ytdl ? 'GET /api/stream/:videoId  ✅' : '❌ Not installed'}`);
    console.log(`❤️  Health:    GET /api/health\n`);
});
