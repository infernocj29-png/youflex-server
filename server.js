const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ API KEYS ============
const TMDB_API_KEY = process.env.TMDB_API_KEY || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting...');
console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
console.log(`📡 YouTube API: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Missing'}`);

// ============ MIDDLEWARE ============
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
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('⚠️ CORS request from unknown origin:', origin);
            callback(null, true); // Allow but log
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ============ CACHE ============
class Cache {
    constructor(ttl = 5 * 60 * 1000) {
        this.cache = new Map();
        this.ttl = ttl;
    }
    set(key, value) { this.cache.set(key, { value, timestamp: Date.now() }); }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttl) { this.cache.delete(key); return null; }
        return entry.value;
    }
    clear() { this.cache.clear(); }
    getStats() {
        let total = 0, expired = 0;
        for (const [, entry] of this.cache) { total++; if (Date.now() - entry.timestamp > this.ttl) expired++; }
        return { total, expired, active: total - expired };
    }
}

const cache = {
    trending: new Cache(3 * 60 * 1000),
    details: new Cache(10 * 60 * 1000),
    search: new Cache(2 * 60 * 1000),
    genres: new Cache(30 * 60 * 1000),
    credits: new Cache(10 * 60 * 1000),
    similar: new Cache(10 * 60 * 1000),
    providers: new Cache(10 * 60 * 1000),
    episodes: new Cache(10 * 60 * 1000),
    youtube: new Cache(5 * 60 * 1000),
    embed: new Cache(60 * 60 * 1000),
    recommendations: new Cache(30 * 60 * 1000),
    trailer: new Cache(30 * 60 * 1000),
};

function cacheMiddleware(cacheInstance, keyGenerator = null) {
    return (req, res, next) => {
        const key = keyGenerator ? keyGenerator(req) : req.originalUrl;
        const cached = cacheInstance.get(key);
        if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
        const originalJson = res.json;
        res.json = function (data) {
            cacheInstance.set(key, data);
            res.setHeader('X-Cache', 'MISS');
            originalJson.call(this, data);
        };
        next();
    };
}

// ============ TMDB HELPER ============
const tmdbCache = new Cache(5 * 60 * 1000);

async function tmdbFetch(endpoint, params = {}, retries = 2) {
    const url = `https://api.themoviedb.org/3${endpoint}`;
    const allParams = { api_key: TMDB_API_KEY, ...params };
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                params: allParams,
                timeout: 10000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'YOUFLEX/1.0' }
            });
            tmdbCache.set(cacheKey, response.data);
            return response.data;
        } catch (error) {
            console.error(`❌ TMDB attempt ${attempt} failed for ${endpoint}:`, error.message);
            if (attempt === retries) return { results: [] };
            await new Promise(r => setTimeout(r, attempt * 500));
        }
    }
}

// ============ YOUTUBE HELPER ============
const youtubeCache = new Cache(5 * 60 * 1000);

async function youtubeFetch(endpoint, params = {}) {
    const url = `https://www.googleapis.com/youtube/v3${endpoint}`;
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached = youtubeCache.get(cacheKey);
    if (cached) return cached;
    try {
        const response = await axios.get(url, { params: { key: YOUTUBE_API_KEY, ...params }, timeout: 10000 });
        youtubeCache.set(cacheKey, response.data);
        return response.data;
    } catch (error) {
        console.error('❌ YouTube API Error:', error.message);
        throw error;
    }
}

// ============ TRAILER SYSTEM ============

async function getTrailerFromTMDB(type, id) {
    try {
        const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];
        const priorityOrder = ['Trailer', 'Teaser', 'Clip', 'Featurette'];
        const youtubeVideos = videos.filter(v => v.site === 'YouTube');
        const sorted = youtubeVideos.sort((a, b) => {
            const aIndex = priorityOrder.indexOf(a.type);
            const bIndex = priorityOrder.indexOf(b.type);
            if (aIndex === bIndex) {
                if (a.official && !b.official) return -1;
                if (!a.official && b.official) return 1;
                return 0;
            }
            return aIndex - bIndex;
        });
        if (sorted.length > 0) {
            const best = sorted[0];
            return {
                success: true, videoId: best.key, site: best.site,
                type: best.type, name: best.name || `${best.type}`,
                official: best.official || false, publishedAt: best.published_at || null
            };
        }
        return { success: false, message: 'No YouTube trailer found in TMDB' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

async function searchYouTubeTrailer(title, year, type = 'movie') {
    if (!YOUTUBE_API_KEY) return { success: false, message: 'YouTube API not configured' };

    const searchQueries = [];
    if (year) {
        searchQueries.push(`${title} ${year} official trailer`);
        searchQueries.push(`${title} ${year} trailer`);
    }
    searchQueries.push(`${title} official trailer`);
    searchQueries.push(`${title} trailer`);
    if (type === 'tv') {
        searchQueries.push(`${title} series trailer`);
        searchQueries.push(`${title} tv show trailer`);
    }

    const triedQueries = new Set();

    for (const query of searchQueries) {
        if (triedQueries.has(query.toLowerCase())) continue;
        triedQueries.add(query.toLowerCase());
        try {
            console.log(`🔍 YouTube search: "${query}"`);
            const data = await youtubeFetch('/search', {
                part: 'snippet', q: query, maxResults: 10,
                type: 'video', videoEmbeddable: 'true', order: 'relevance'
            });
            if (!data.items?.length) continue;

            const scoredResults = data.items.map(item => {
                const titleLower = item.snippet.title.toLowerCase();
                const channelTitle = item.snippet.channelTitle.toLowerCase();
                let score = 0;

                if (titleLower.includes('official')) score += 30;
                if (titleLower.includes('trailer')) score += 20;
                if (titleLower.includes('teaser')) score += 10;
                if (titleLower.includes('preview')) score += 5;

                const studios = ['marvel', 'disney', 'netflix', 'hbo', 'apple', 'paramount', 'universal', 'warner', 'sony', '20th century', 'lucasfilm', 'pixar', 'dreamworks', 'a24', 'lionsgate', 'mgm'];
                studios.forEach(studio => { if (channelTitle.includes(studio)) score += 20; });
                if (channelTitle.includes('official')) score += 15;
                if (channelTitle.includes('studio')) score += 10;

                if (year && titleLower.includes(year.toString())) score += 15;

                const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3);
                let matches = 0;
                titleWords.forEach(w => { if (titleLower.includes(w)) matches++; });
                if (titleWords.length > 0) score += (matches / titleWords.length) * 20;

                const penalties = ['review', 'reaction', 'explained', 'ending', 'breakdown', 'analysis', 'recap', 'spoiler', 'hidden details', 'easter egg', 'theories'];
                penalties.forEach(p => { if (titleLower.includes(p)) score -= 30; });

                return { ...item, score };
            });

            scoredResults.sort((a, b) => b.score - a.score);
            const good = scoredResults.filter(r => r.score > 10);

            if (good.length > 0) {
                const best = good[0];
                console.log(`✅ Found trailer: "${best.snippet.title}" (score: ${best.score})`);
                return {
                    success: true, videoId: best.id.videoId,
                    title: best.snippet.title, channelTitle: best.snippet.channelTitle,
                    thumbnail: best.snippet.thumbnails?.medium?.url || null,
                    publishedAt: best.snippet.publishedAt, score: best.score
                };
            }
        } catch (error) {
            console.error(`❌ YouTube search error for "${query}":`, error.message);
        }
    }
    return { success: false, message: 'No suitable trailer found on YouTube' };
}

async function getTrailer(type, id) {
    console.log(`🎬 Getting trailer for ${type}/${id}`);
    try {
        const tmdbResult = await getTrailerFromTMDB(type, id);
        if (tmdbResult.success) {
            console.log(`✅ TMDB trailer found: ${tmdbResult.name}`);
            return { ...tmdbResult, source: 'tmdb' };
        }

        const details = await tmdbFetch(`/${type}/${id}`);
        const title = details.title || details.name;
        const year = details.release_date || details.first_air_date;
        const yearStr = year ? new Date(year).getFullYear().toString() : null;

        if (!title) return { success: false, message: 'Movie/TV details not found' };

        const ytResult = await searchYouTubeTrailer(title, yearStr, type);
        if (ytResult.success) {
            console.log(`✅ YouTube trailer found: ${ytResult.title}`);
            return {
                success: true, videoId: ytResult.videoId, site: 'YouTube',
                type: 'Trailer', name: ytResult.title, official: ytResult.score > 50,
                source: 'youtube', channelTitle: ytResult.channelTitle, publishedAt: ytResult.publishedAt
            };
        }
        return { success: false, message: 'No trailer found' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// ============ ROOT ============
app.get('/', (req, res) => {
    res.json({
        name: 'YOUFLEX API', version: '2.0.0', status: 'running',
        endpoints: {
            health: '/api/health',
            trending: '/api/trending',
            content: '/api/content/:category',
            genre: '/api/genre/:id',
            details: '/api/details/:type/:id',
            credits: '/api/credits/:type/:id',
            similar: '/api/similar/:type/:id',
            providers: '/api/providers/:type/:id',
            episodes: '/api/episodes/:tvId/:season',
            search: '/api/search?query=...',
            trailer: '/api/trailer/:type/:id',
            youtubeSearch: '/api/youtube/search?q=...',
            youtubeVideo: '/api/youtube/video/:id',
            // ✅ VIDSRC.ME EMBED ENDPOINTS
            embedMovie: '/api/embed/movie/:tmdbId',
            embedTv: '/api/embed/tv/:tmdbId/:season/:episode',
            // Also supports IMDB ID
            embedMovieImdb: '/api/embed/movie/imdb/:imdbId',
            embedTvImdb: '/api/embed/tv/imdb/:imdbId/:season/:episode',
            genres: '/api/genres',
            genresAll: '/api/genres/all',
            recommendationsEnhanced: '/api/recommendations/enhanced/:type/:id',
        }
    });
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK', timestamp: new Date().toISOString(),
        cache: { tmdb: tmdbCache.getStats(), youtube: youtubeCache.getStats(), trailer: cache.trailer.getStats() },
        services: {
            tmdb: { configured: !!TMDB_API_KEY },
            youtube: { configured: !!YOUTUBE_API_KEY }
        },
        environment: process.env.NODE_ENV || 'development'
    });
});

// ============================================================
// ✅ VIDSRC.ME EMBED ENDPOINTS
// ============================================================

/**
 * GET /api/embed/movie/:tmdbId
 * Returns embed URL and HTML for a movie by TMDB ID
 */
app.get('/api/embed/movie/:tmdbId', cacheMiddleware(cache.embed, (req) => `embed:movie:tmdb:${req.params.tmdbId}`), async (req, res) => {
    const { tmdbId } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid TMDB ID. Must be a number.' });
    }
    const embedUrl = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`;
    res.json({
        success: true,
        data: {
            tmdbId, type: 'movie', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/movie/imdb/:imdbId
 * Returns embed URL for a movie by IMDB ID
 */
app.get('/api/embed/movie/imdb/:imdbId', cacheMiddleware(cache.embed, (req) => `embed:movie:imdb:${req.params.imdbId}`), async (req, res) => {
    const { imdbId } = req.params;
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid IMDB ID. Must start with "tt" followed by numbers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/movie?imdb=${imdbId}`;
    res.json({
        success: true,
        data: {
            imdbId, type: 'movie', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/tv/:tmdbId/:season/:episode
 * Returns embed URL for a TV episode by TMDB ID
 */
app.get('/api/embed/tv/:tmdbId/:season/:episode', cacheMiddleware(cache.embed, (req) => `embed:tv:tmdb:${req.params.tmdbId}:${req.params.season}:${req.params.episode}`), async (req, res) => {
    const { tmdbId, season, episode } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid TMDB ID. Must be a number.' });
    }
    const s = parseInt(season);
    const e = parseInt(episode);
    if (isNaN(s) || isNaN(e) || s < 1 || e < 1) {
        return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${s}&episode=${e}`;
    res.json({
        success: true,
        data: {
            tmdbId, season: s, episode: e, type: 'tv', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/tv/imdb/:imdbId/:season/:episode
 * Returns embed URL for a TV episode by IMDB ID
 */
app.get('/api/embed/tv/imdb/:imdbId/:season/:episode', cacheMiddleware(cache.embed, (req) => `embed:tv:imdb:${req.params.imdbId}:${req.params.season}:${req.params.episode}`), async (req, res) => {
    const { imdbId, season, episode } = req.params;
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid IMDB ID. Must start with "tt".' });
    }
    const s = parseInt(season);
    const e = parseInt(episode);
    if (isNaN(s) || isNaN(e) || s < 1 || e < 1) {
        return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${s}&episode=${e}`;
    res.json({
        success: true,
        data: {
            imdbId, season: s, episode: e, type: 'tv', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

// ============================================================
// ✅ TRAILER ENDPOINT
// ============================================================

app.get('/api/trailer/:type/:id',
    cacheMiddleware(cache.trailer, (req) => `trailer:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Type must be "movie" or "tv".' });
        }
        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ success: false, error: 'ID must be a number.' });
        }
        try {
            const result = await getTrailer(type, parseInt(id));
            if (result.success) {
                res.json({
                    success: true,
                    data: {
                        videoId: result.videoId,
                        site: result.site || 'YouTube',
                        type: result.type || 'Trailer',
                        name: result.name || 'Trailer',
                        official: result.official || false,
                        source: result.source || 'unknown',
                        channelTitle: result.channelTitle || null,
                        publishedAt: result.publishedAt || null,
                        embedUrl: `https://www.youtube.com/embed/${result.videoId}`,
                        embedUrlAutoplay: `https://www.youtube.com/embed/${result.videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`
                    }
                });
            } else {
                res.json({ success: false, error: result.message || 'No trailer found', data: null });
            }
        } catch (error) {
            console.error('❌ Trailer endpoint error:', error);
            res.status(500).json({ success: false, error: 'Internal server error', data: null });
        }
    }
);

// ============================================================
// ✅ YOUTUBE ENDPOINTS
// ============================================================

app.get('/api/youtube/search',
    cacheMiddleware(cache.youtube, (req) => `ytsearch:${req.query.q}:${req.query.maxResults || 5}`),
    async (req, res) => {
        const { q, maxResults = 5 } = req.query;
        if (!q) return res.json({ success: false, error: 'Missing query', data: null });
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        try {
            const data = await youtubeFetch('/search', {
                part: 'snippet', q, maxResults: parseInt(maxResults),
                type: 'video', videoEmbeddable: 'true'
            });
            const items = (data.items || []).map(item => ({
                id: item.id.videoId, title: item.snippet.title,
                channelTitle: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails?.medium?.url || '',
                publishedAt: item.snippet.publishedAt
            }));
            res.json({ success: true, data: { items } });
        } catch (error) {
            res.json({ success: false, error: error.message, data: null });
        }
    }
);

app.get('/api/youtube/video/:id',
    cacheMiddleware(cache.youtube, (req) => `ytvideo:${req.params.id}`),
    async (req, res) => {
        const { id } = req.params;
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
            return res.json({ success: false, error: 'Invalid video ID', data: null });
        }
        try {
            const data = await youtubeFetch('/videos', { part: 'statistics,snippet', id });
            const video = (data.items || [])[0];
            if (!video) return res.json({ success: false, error: 'Video not found', data: null });
            res.json({
                success: true,
                data: {
                    viewCount: video.statistics?.viewCount,
                    likeCount: video.statistics?.likeCount,
                    channelTitle: video.snippet?.channelTitle,
                    title: video.snippet?.title,
                    publishedAt: video.snippet?.publishedAt
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message, data: null });
        }
    }
);

// ============================================================
// ✅ ALL REMAINING TMDB ENDPOINTS (unchanged)
// ============================================================

// TRENDING
app.get('/api/trending', cacheMiddleware(cache.trending), async (req, res) => {
    try {
        const [trending, upcoming, nowPlaying] = await Promise.all([
            tmdbFetch('/trending/all/day'),
            tmdbFetch('/movie/upcoming'),
            tmdbFetch('/movie/now_playing')
        ]);
        const formatItems = (items, category, mediaType) => (items || [])
            .filter(item => item.backdrop_path && item.media_type !== 'person')
            .slice(0, 4)
            .map(item => ({ ...item, media_type: mediaType || item.media_type || 'movie', heroCategory: category }));
        const heroItems = [
            ...formatItems(trending.results, 'trending'),
            ...formatItems(upcoming.results, 'upcoming', 'movie'),
            ...formatItems(nowPlaying.results, 'now-playing', 'movie')
        ];
        res.json({ success: true, data: heroItems });
    } catch (error) {
        console.error('❌ Trending Error:', error.message);
        res.json({ success: true, data: [] });
    }
});

// CONTENT BY CATEGORY
app.get('/api/content/:category',
    cacheMiddleware(cache.details, (req) => `content:${req.params.category}:${JSON.stringify(req.query)}`),
    async (req, res) => {
        const { category } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            let endpoint = '/discover/movie';
            let params = { page: parseInt(page), sort_by: sort };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year) params['primary_release_year'] = parseInt(year);
            switch (category) {
                case 'trending': endpoint = '/trending/all/week'; params = { page: parseInt(page) }; break;
                case 'popular': endpoint = '/discover/movie'; params = { ...params, sort_by: 'popularity.desc' }; break;
                case 'tv': endpoint = '/discover/tv'; break;
                case 'movie': endpoint = '/discover/movie'; break;
                case 'upcoming': endpoint = '/movie/upcoming'; params = { page: parseInt(page) }; break;
                case 'now-playing': endpoint = '/movie/now_playing'; params = { page: parseInt(page) }; break;
                case 'top-rated': endpoint = `/discover/${type}`; params = { ...params, 'vote_count.gte': 200 }; break;
                case 'anime': endpoint = '/discover/tv'; params = { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc', page: parseInt(page) }; break;
                case 'animation': endpoint = '/discover/movie'; params = { with_genres: 16, sort_by: 'popularity.desc', page: parseInt(page) }; break;
                default: endpoint = '/discover/movie'; params = { page: parseInt(page), sort_by: 'popularity.desc' };
            }
            const data = await tmdbFetch(endpoint, params);
            res.json({ success: true, data });
        } catch (error) {
            console.error(`❌ Content Error (${category}):`, error.message);
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    }
);

// GENRE DISCOVERY
app.get('/api/genre/:id',
    cacheMiddleware(cache.details, (req) => `genre:${req.params.id}:${JSON.stringify(req.query)}`),
    async (req, res) => {
        const { id } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            const params = { page: parseInt(page), sort_by: sort, with_genres: id };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year) {
                if (type === 'tv') params['first_air_date_year'] = parseInt(year);
                else params['primary_release_year'] = parseInt(year);
            }
            const data = await tmdbFetch(`/discover/${type}`, params);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    }
);

// GENRES
app.get('/api/genres/all', cacheMiddleware(cache.genres), async (req, res) => {
    try {
        const [movieGenres, tvGenres] = await Promise.all([tmdbFetch('/genre/movie/list'), tmdbFetch('/genre/tv/list')]);
        const merged = {};
        [...(movieGenres.genres || []), ...(tvGenres.genres || [])].forEach(g => { merged[g.id] = g.name; });
        res.json({ success: true, data: merged });
    } catch (error) {
        res.json({ success: true, data: {} });
    }
});

app.get('/api/genres',
    cacheMiddleware(cache.genres, (req) => `genres:${req.query.type || 'movie'}`),
    async (req, res) => {
        const { type = 'movie' } = req.query;
        try {
            const data = await tmdbFetch(`/genre/${type}/list`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { genres: [] } });
        }
    }
);

// DETAILS
app.get('/api/details/:type/:id',
    cacheMiddleware(cache.details, (req) => `details:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos,images,credits,similar,watch/providers,external_ids' });
            res.json({ success: true, data });
        } catch (error) {
            res.json({
                success: true,
                data: { id: parseInt(id), title: 'Unavailable', name: 'Unavailable', overview: "Sorry, we couldn't load details.", poster_path: null, backdrop_path: null, vote_average: 0, genres: [], credits: { cast: [] }, videos: { results: [] } }
            });
        }
    }
);

// SEARCH
app.get('/api/search',
    cacheMiddleware(cache.search, (req) => `search:${req.query.query}:${req.query.page || 1}`),
    async (req, res) => {
        const { query, page = 1 } = req.query;
        if (!query || query.length < 2) return res.json({ success: true, data: { results: [] } });
        try {
            const data = await tmdbFetch('/search/multi', { query, page: parseInt(page) });
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [] } });
        }
    }
);

// CREDITS
app.get('/api/credits/:type/:id',
    cacheMiddleware(cache.credits, (req) => `credits:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/credits`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { cast: [] } });
        }
    }
);

// EPISODES
app.get('/api/episodes/:tvId/:season',
    cacheMiddleware(cache.episodes, (req) => `episodes:${req.params.tvId}:${req.params.season}`),
    async (req, res) => {
        const { tvId, season } = req.params;
        try {
            const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { episodes: [] } });
        }
    }
);

// WATCH PROVIDERS
app.get('/api/providers/:type/:id',
    cacheMiddleware(cache.providers, (req) => `providers:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: {} } });
        }
    }
);

// SIMILAR
app.get('/api/similar/:type/:id',
    cacheMiddleware(cache.similar, (req) => `similar:${req.params.type}:${req.params.id}:${req.query.page || 1}`),
    async (req, res) => {
        const { type, id } = req.params;
        const { page = 1 } = req.query;
        try {
            const data = await tmdbFetch(`/${type}/${id}/similar`, { page: parseInt(page) });
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [] } });
        }
    }
);

// ============ ENHANCED RECOMMENDATIONS ============

async function computeSimilarityScore(sourceItem, candidateItem) {
    const sourceGenres = new Set(sourceItem.genre_ids || (sourceItem.genres || []).map(g => g.id));
    const candidateGenres = new Set(candidateItem.genre_ids || (candidateItem.genres || []).map(g => g.id));
    const genreIntersection = [...sourceGenres].filter(g => candidateGenres.has(g)).length;
    const genreUnion = new Set([...sourceGenres, ...candidateGenres]).size;
    const genreScore = genreUnion > 0 ? genreIntersection / genreUnion : 0;

    const sourceYear = parseInt((sourceItem.release_date || sourceItem.first_air_date || '2000').split('-')[0]);
    const candidateYear = parseInt((candidateItem.release_date || candidateItem.first_air_date || '2000').split('-')[0]);
    const yearDiff = Math.abs(sourceYear - candidateYear);
    const yearScore = Math.max(0, 1 - (yearDiff / 20));

    const sourceRating = parseFloat(sourceItem.vote_average) || 5;
    const candidateRating = parseFloat(candidateItem.vote_average) || 5;
    const ratingDiff = Math.abs(sourceRating - candidateRating);
    const ratingScore = Math.max(0, 1 - (ratingDiff / 5));

    const popularityScore = Math.min(1, (candidateItem.vote_count || 0) / 1000);

    return (genreScore * 0.4) + (yearScore * 0.2) + (ratingScore * 0.2) + (popularityScore * 0.2);
}

async function getEnhancedRecommendations(id, type, userId = null) {
    try {
        const [sourceDetails, similar, recommendations] = await Promise.all([
            tmdbFetch(`/${type}/${id}`),
            tmdbFetch(`/${type}/${id}/similar`),
            tmdbFetch(`/${type}/${id}/recommendations`)
        ]);

        const allCandidates = [
            ...(similar.results || []).slice(0, 20),
            ...(recommendations.results || []).slice(0, 20)
        ];

        const uniqueCandidates = Array.from(new Map(allCandidates.map(item => [item.id, item])).values())
            .filter(item => item.id !== id);

        const scored = await Promise.all(
            uniqueCandidates.map(async (item) => {
                const score = await computeSimilarityScore(sourceDetails, item);
                return { ...item, score, media_type: type };
            })
        );

        scored.sort((a, b) => b.score - a.score);

        return {
            sourceId: id, sourceType: type,
            sourceTitle: sourceDetails.title || sourceDetails.name,
            recommendations: scored.slice(0, 20),
            generatedAt: new Date().toISOString()
        };
    } catch (error) {
        throw new Error(`Enhanced recommendations failed: ${error.message}`);
    }
}

app.get('/api/recommendations/enhanced/:type/:id',
    cacheMiddleware(cache.recommendations, (req) => `enhanced_rec_${req.params.type}_${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const result = await getEnhancedRecommendations(parseInt(id), type);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message, data: { recommendations: [] } });
        }
    }
);

app.get('/api/recommendations/batch', async (req, res) => {
    const { ids, type = 'movie' } = req.query;
    if (!ids) return res.json({ success: false, error: 'No IDs provided' });
    const movieIds = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    try {
        const results = await Promise.all(movieIds.map(async (id) => {
            try { return { id, ...(await getEnhancedRecommendations(id, type)) }; }
            catch (error) { return { id, error: error.message }; }
        }));
        res.json({ success: true, data: results });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/recommendations/cache/clear', (req, res) => {
    cache.recommendations.clear();
    res.json({ success: true, message: 'Recommendation cache cleared' });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`\n✅ VIDSRC.ME embed endpoints:`);
    console.log(`   Movie (TMDB): GET /api/embed/movie/:tmdbId`);
    console.log(`   Movie (IMDB): GET /api/embed/movie/imdb/:imdbId`);
    console.log(`   TV (TMDB):    GET /api/embed/tv/:tmdbId/:season/:episode`);
    console.log(`   TV (IMDB):    GET /api/embed/tv/imdb/:imdbId/:season/:episode`);
    console.log(`\n✅ Trailer endpoint:`);
    console.log(`   GET /api/trailer/:type/:id  →  TMDB videos → YouTube fallback`);
    console.log(`\n✅ All TMDB endpoints active`);
});const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ API KEYS ============
const TMDB_API_KEY = process.env.TMDB_API_KEY || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting...');
console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
console.log(`📡 YouTube API: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Missing'}`);

// ============ MIDDLEWARE ============
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
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('⚠️ CORS request from unknown origin:', origin);
            callback(null, true); // Allow but log
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ============ CACHE ============
class Cache {
    constructor(ttl = 5 * 60 * 1000) {
        this.cache = new Map();
        this.ttl = ttl;
    }
    set(key, value) { this.cache.set(key, { value, timestamp: Date.now() }); }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttl) { this.cache.delete(key); return null; }
        return entry.value;
    }
    clear() { this.cache.clear(); }
    getStats() {
        let total = 0, expired = 0;
        for (const [, entry] of this.cache) { total++; if (Date.now() - entry.timestamp > this.ttl) expired++; }
        return { total, expired, active: total - expired };
    }
}

const cache = {
    trending: new Cache(3 * 60 * 1000),
    details: new Cache(10 * 60 * 1000),
    search: new Cache(2 * 60 * 1000),
    genres: new Cache(30 * 60 * 1000),
    credits: new Cache(10 * 60 * 1000),
    similar: new Cache(10 * 60 * 1000),
    providers: new Cache(10 * 60 * 1000),
    episodes: new Cache(10 * 60 * 1000),
    youtube: new Cache(5 * 60 * 1000),
    embed: new Cache(60 * 60 * 1000),
    recommendations: new Cache(30 * 60 * 1000),
    trailer: new Cache(30 * 60 * 1000),
};

function cacheMiddleware(cacheInstance, keyGenerator = null) {
    return (req, res, next) => {
        const key = keyGenerator ? keyGenerator(req) : req.originalUrl;
        const cached = cacheInstance.get(key);
        if (cached) { res.setHeader('X-Cache', 'HIT'); return res.json(cached); }
        const originalJson = res.json;
        res.json = function (data) {
            cacheInstance.set(key, data);
            res.setHeader('X-Cache', 'MISS');
            originalJson.call(this, data);
        };
        next();
    };
}

// ============ TMDB HELPER ============
const tmdbCache = new Cache(5 * 60 * 1000);

async function tmdbFetch(endpoint, params = {}, retries = 2) {
    const url = `https://api.themoviedb.org/3${endpoint}`;
    const allParams = { api_key: TMDB_API_KEY, ...params };
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached = tmdbCache.get(cacheKey);
    if (cached) return cached;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                params: allParams,
                timeout: 10000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'YOUFLEX/1.0' }
            });
            tmdbCache.set(cacheKey, response.data);
            return response.data;
        } catch (error) {
            console.error(`❌ TMDB attempt ${attempt} failed for ${endpoint}:`, error.message);
            if (attempt === retries) return { results: [] };
            await new Promise(r => setTimeout(r, attempt * 500));
        }
    }
}

// ============ YOUTUBE HELPER ============
const youtubeCache = new Cache(5 * 60 * 1000);

async function youtubeFetch(endpoint, params = {}) {
    const url = `https://www.googleapis.com/youtube/v3${endpoint}`;
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached = youtubeCache.get(cacheKey);
    if (cached) return cached;
    try {
        const response = await axios.get(url, { params: { key: YOUTUBE_API_KEY, ...params }, timeout: 10000 });
        youtubeCache.set(cacheKey, response.data);
        return response.data;
    } catch (error) {
        console.error('❌ YouTube API Error:', error.message);
        throw error;
    }
}

// ============ TRAILER SYSTEM ============

async function getTrailerFromTMDB(type, id) {
    try {
        const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];
        const priorityOrder = ['Trailer', 'Teaser', 'Clip', 'Featurette'];
        const youtubeVideos = videos.filter(v => v.site === 'YouTube');
        const sorted = youtubeVideos.sort((a, b) => {
            const aIndex = priorityOrder.indexOf(a.type);
            const bIndex = priorityOrder.indexOf(b.type);
            if (aIndex === bIndex) {
                if (a.official && !b.official) return -1;
                if (!a.official && b.official) return 1;
                return 0;
            }
            return aIndex - bIndex;
        });
        if (sorted.length > 0) {
            const best = sorted[0];
            return {
                success: true, videoId: best.key, site: best.site,
                type: best.type, name: best.name || `${best.type}`,
                official: best.official || false, publishedAt: best.published_at || null
            };
        }
        return { success: false, message: 'No YouTube trailer found in TMDB' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

async function searchYouTubeTrailer(title, year, type = 'movie') {
    if (!YOUTUBE_API_KEY) return { success: false, message: 'YouTube API not configured' };

    const searchQueries = [];
    if (year) {
        searchQueries.push(`${title} ${year} official trailer`);
        searchQueries.push(`${title} ${year} trailer`);
    }
    searchQueries.push(`${title} official trailer`);
    searchQueries.push(`${title} trailer`);
    if (type === 'tv') {
        searchQueries.push(`${title} series trailer`);
        searchQueries.push(`${title} tv show trailer`);
    }

    const triedQueries = new Set();

    for (const query of searchQueries) {
        if (triedQueries.has(query.toLowerCase())) continue;
        triedQueries.add(query.toLowerCase());
        try {
            console.log(`🔍 YouTube search: "${query}"`);
            const data = await youtubeFetch('/search', {
                part: 'snippet', q: query, maxResults: 10,
                type: 'video', videoEmbeddable: 'true', order: 'relevance'
            });
            if (!data.items?.length) continue;

            const scoredResults = data.items.map(item => {
                const titleLower = item.snippet.title.toLowerCase();
                const channelTitle = item.snippet.channelTitle.toLowerCase();
                let score = 0;

                if (titleLower.includes('official')) score += 30;
                if (titleLower.includes('trailer')) score += 20;
                if (titleLower.includes('teaser')) score += 10;
                if (titleLower.includes('preview')) score += 5;

                const studios = ['marvel', 'disney', 'netflix', 'hbo', 'apple', 'paramount', 'universal', 'warner', 'sony', '20th century', 'lucasfilm', 'pixar', 'dreamworks', 'a24', 'lionsgate', 'mgm'];
                studios.forEach(studio => { if (channelTitle.includes(studio)) score += 20; });
                if (channelTitle.includes('official')) score += 15;
                if (channelTitle.includes('studio')) score += 10;

                if (year && titleLower.includes(year.toString())) score += 15;

                const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3);
                let matches = 0;
                titleWords.forEach(w => { if (titleLower.includes(w)) matches++; });
                if (titleWords.length > 0) score += (matches / titleWords.length) * 20;

                const penalties = ['review', 'reaction', 'explained', 'ending', 'breakdown', 'analysis', 'recap', 'spoiler', 'hidden details', 'easter egg', 'theories'];
                penalties.forEach(p => { if (titleLower.includes(p)) score -= 30; });

                return { ...item, score };
            });

            scoredResults.sort((a, b) => b.score - a.score);
            const good = scoredResults.filter(r => r.score > 10);

            if (good.length > 0) {
                const best = good[0];
                console.log(`✅ Found trailer: "${best.snippet.title}" (score: ${best.score})`);
                return {
                    success: true, videoId: best.id.videoId,
                    title: best.snippet.title, channelTitle: best.snippet.channelTitle,
                    thumbnail: best.snippet.thumbnails?.medium?.url || null,
                    publishedAt: best.snippet.publishedAt, score: best.score
                };
            }
        } catch (error) {
            console.error(`❌ YouTube search error for "${query}":`, error.message);
        }
    }
    return { success: false, message: 'No suitable trailer found on YouTube' };
}

async function getTrailer(type, id) {
    console.log(`🎬 Getting trailer for ${type}/${id}`);
    try {
        const tmdbResult = await getTrailerFromTMDB(type, id);
        if (tmdbResult.success) {
            console.log(`✅ TMDB trailer found: ${tmdbResult.name}`);
            return { ...tmdbResult, source: 'tmdb' };
        }

        const details = await tmdbFetch(`/${type}/${id}`);
        const title = details.title || details.name;
        const year = details.release_date || details.first_air_date;
        const yearStr = year ? new Date(year).getFullYear().toString() : null;

        if (!title) return { success: false, message: 'Movie/TV details not found' };

        const ytResult = await searchYouTubeTrailer(title, yearStr, type);
        if (ytResult.success) {
            console.log(`✅ YouTube trailer found: ${ytResult.title}`);
            return {
                success: true, videoId: ytResult.videoId, site: 'YouTube',
                type: 'Trailer', name: ytResult.title, official: ytResult.score > 50,
                source: 'youtube', channelTitle: ytResult.channelTitle, publishedAt: ytResult.publishedAt
            };
        }
        return { success: false, message: 'No trailer found' };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// ============ ROOT ============
app.get('/', (req, res) => {
    res.json({
        name: 'YOUFLEX API', version: '2.0.0', status: 'running',
        endpoints: {
            health: '/api/health',
            trending: '/api/trending',
            content: '/api/content/:category',
            genre: '/api/genre/:id',
            details: '/api/details/:type/:id',
            credits: '/api/credits/:type/:id',
            similar: '/api/similar/:type/:id',
            providers: '/api/providers/:type/:id',
            episodes: '/api/episodes/:tvId/:season',
            search: '/api/search?query=...',
            trailer: '/api/trailer/:type/:id',
            youtubeSearch: '/api/youtube/search?q=...',
            youtubeVideo: '/api/youtube/video/:id',
            // ✅ VIDSRC.ME EMBED ENDPOINTS
            embedMovie: '/api/embed/movie/:tmdbId',
            embedTv: '/api/embed/tv/:tmdbId/:season/:episode',
            // Also supports IMDB ID
            embedMovieImdb: '/api/embed/movie/imdb/:imdbId',
            embedTvImdb: '/api/embed/tv/imdb/:imdbId/:season/:episode',
            genres: '/api/genres',
            genresAll: '/api/genres/all',
            recommendationsEnhanced: '/api/recommendations/enhanced/:type/:id',
        }
    });
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK', timestamp: new Date().toISOString(),
        cache: { tmdb: tmdbCache.getStats(), youtube: youtubeCache.getStats(), trailer: cache.trailer.getStats() },
        services: {
            tmdb: { configured: !!TMDB_API_KEY },
            youtube: { configured: !!YOUTUBE_API_KEY }
        },
        environment: process.env.NODE_ENV || 'development'
    });
});

// ============================================================
// ✅ VIDSRC.ME EMBED ENDPOINTS
// ============================================================

/**
 * GET /api/embed/movie/:tmdbId
 * Returns embed URL and HTML for a movie by TMDB ID
 */
app.get('/api/embed/movie/:tmdbId', cacheMiddleware(cache.embed, (req) => `embed:movie:tmdb:${req.params.tmdbId}`), async (req, res) => {
    const { tmdbId } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid TMDB ID. Must be a number.' });
    }
    const embedUrl = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`;
    res.json({
        success: true,
        data: {
            tmdbId, type: 'movie', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/movie/imdb/:imdbId
 * Returns embed URL for a movie by IMDB ID
 */
app.get('/api/embed/movie/imdb/:imdbId', cacheMiddleware(cache.embed, (req) => `embed:movie:imdb:${req.params.imdbId}`), async (req, res) => {
    const { imdbId } = req.params;
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid IMDB ID. Must start with "tt" followed by numbers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/movie?imdb=${imdbId}`;
    res.json({
        success: true,
        data: {
            imdbId, type: 'movie', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/tv/:tmdbId/:season/:episode
 * Returns embed URL for a TV episode by TMDB ID
 */
app.get('/api/embed/tv/:tmdbId/:season/:episode', cacheMiddleware(cache.embed, (req) => `embed:tv:tmdb:${req.params.tmdbId}:${req.params.season}:${req.params.episode}`), async (req, res) => {
    const { tmdbId, season, episode } = req.params;
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid TMDB ID. Must be a number.' });
    }
    const s = parseInt(season);
    const e = parseInt(episode);
    if (isNaN(s) || isNaN(e) || s < 1 || e < 1) {
        return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${s}&episode=${e}`;
    res.json({
        success: true,
        data: {
            tmdbId, season: s, episode: e, type: 'tv', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

/**
 * GET /api/embed/tv/imdb/:imdbId/:season/:episode
 * Returns embed URL for a TV episode by IMDB ID
 */
app.get('/api/embed/tv/imdb/:imdbId/:season/:episode', cacheMiddleware(cache.embed, (req) => `embed:tv:imdb:${req.params.imdbId}:${req.params.season}:${req.params.episode}`), async (req, res) => {
    const { imdbId, season, episode } = req.params;
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({ success: false, error: 'Invalid IMDB ID. Must start with "tt".' });
    }
    const s = parseInt(season);
    const e = parseInt(episode);
    if (isNaN(s) || isNaN(e) || s < 1 || e < 1) {
        return res.status(400).json({ success: false, error: 'Season and episode must be positive integers.' });
    }
    const embedUrl = `https://vidsrc.me/embed/tv?imdb=${imdbId}&season=${s}&episode=${e}`;
    res.json({
        success: true,
        data: {
            imdbId, season: s, episode: e, type: 'tv', source: 'vidsrc.me',
            embedUrl,
            html: `<iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen allow="autoplay; encrypted-media; fullscreen" referrerpolicy="origin"></iframe>`
        }
    });
});

// ============================================================
// ✅ TRAILER ENDPOINT
// ============================================================

app.get('/api/trailer/:type/:id',
    cacheMiddleware(cache.trailer, (req) => `trailer:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        if (!['movie', 'tv'].includes(type)) {
            return res.status(400).json({ success: false, error: 'Type must be "movie" or "tv".' });
        }
        if (!id || isNaN(parseInt(id))) {
            return res.status(400).json({ success: false, error: 'ID must be a number.' });
        }
        try {
            const result = await getTrailer(type, parseInt(id));
            if (result.success) {
                res.json({
                    success: true,
                    data: {
                        videoId: result.videoId,
                        site: result.site || 'YouTube',
                        type: result.type || 'Trailer',
                        name: result.name || 'Trailer',
                        official: result.official || false,
                        source: result.source || 'unknown',
                        channelTitle: result.channelTitle || null,
                        publishedAt: result.publishedAt || null,
                        embedUrl: `https://www.youtube.com/embed/${result.videoId}`,
                        embedUrlAutoplay: `https://www.youtube.com/embed/${result.videoId}?autoplay=1&rel=0&modestbranding=1&playsinline=1`
                    }
                });
            } else {
                res.json({ success: false, error: result.message || 'No trailer found', data: null });
            }
        } catch (error) {
            console.error('❌ Trailer endpoint error:', error);
            res.status(500).json({ success: false, error: 'Internal server error', data: null });
        }
    }
);

// ============================================================
// ✅ YOUTUBE ENDPOINTS
// ============================================================

app.get('/api/youtube/search',
    cacheMiddleware(cache.youtube, (req) => `ytsearch:${req.query.q}:${req.query.maxResults || 5}`),
    async (req, res) => {
        const { q, maxResults = 5 } = req.query;
        if (!q) return res.json({ success: false, error: 'Missing query', data: null });
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        try {
            const data = await youtubeFetch('/search', {
                part: 'snippet', q, maxResults: parseInt(maxResults),
                type: 'video', videoEmbeddable: 'true'
            });
            const items = (data.items || []).map(item => ({
                id: item.id.videoId, title: item.snippet.title,
                channelTitle: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails?.medium?.url || '',
                publishedAt: item.snippet.publishedAt
            }));
            res.json({ success: true, data: { items } });
        } catch (error) {
            res.json({ success: false, error: error.message, data: null });
        }
    }
);

app.get('/api/youtube/video/:id',
    cacheMiddleware(cache.youtube, (req) => `ytvideo:${req.params.id}`),
    async (req, res) => {
        const { id } = req.params;
        if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
            return res.json({ success: false, error: 'Invalid video ID', data: null });
        }
        try {
            const data = await youtubeFetch('/videos', { part: 'statistics,snippet', id });
            const video = (data.items || [])[0];
            if (!video) return res.json({ success: false, error: 'Video not found', data: null });
            res.json({
                success: true,
                data: {
                    viewCount: video.statistics?.viewCount,
                    likeCount: video.statistics?.likeCount,
                    channelTitle: video.snippet?.channelTitle,
                    title: video.snippet?.title,
                    publishedAt: video.snippet?.publishedAt
                }
            });
        } catch (error) {
            res.json({ success: false, error: error.message, data: null });
        }
    }
);

// ============================================================
// ✅ ALL REMAINING TMDB ENDPOINTS (unchanged)
// ============================================================

// TRENDING
app.get('/api/trending', cacheMiddleware(cache.trending), async (req, res) => {
    try {
        const [trending, upcoming, nowPlaying] = await Promise.all([
            tmdbFetch('/trending/all/day'),
            tmdbFetch('/movie/upcoming'),
            tmdbFetch('/movie/now_playing')
        ]);
        const formatItems = (items, category, mediaType) => (items || [])
            .filter(item => item.backdrop_path && item.media_type !== 'person')
            .slice(0, 4)
            .map(item => ({ ...item, media_type: mediaType || item.media_type || 'movie', heroCategory: category }));
        const heroItems = [
            ...formatItems(trending.results, 'trending'),
            ...formatItems(upcoming.results, 'upcoming', 'movie'),
            ...formatItems(nowPlaying.results, 'now-playing', 'movie')
        ];
        res.json({ success: true, data: heroItems });
    } catch (error) {
        console.error('❌ Trending Error:', error.message);
        res.json({ success: true, data: [] });
    }
});

// CONTENT BY CATEGORY
app.get('/api/content/:category',
    cacheMiddleware(cache.details, (req) => `content:${req.params.category}:${JSON.stringify(req.query)}`),
    async (req, res) => {
        const { category } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            let endpoint = '/discover/movie';
            let params = { page: parseInt(page), sort_by: sort };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year) params['primary_release_year'] = parseInt(year);
            switch (category) {
                case 'trending': endpoint = '/trending/all/week'; params = { page: parseInt(page) }; break;
                case 'popular': endpoint = '/discover/movie'; params = { ...params, sort_by: 'popularity.desc' }; break;
                case 'tv': endpoint = '/discover/tv'; break;
                case 'movie': endpoint = '/discover/movie'; break;
                case 'upcoming': endpoint = '/movie/upcoming'; params = { page: parseInt(page) }; break;
                case 'now-playing': endpoint = '/movie/now_playing'; params = { page: parseInt(page) }; break;
                case 'top-rated': endpoint = `/discover/${type}`; params = { ...params, 'vote_count.gte': 200 }; break;
                case 'anime': endpoint = '/discover/tv'; params = { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc', page: parseInt(page) }; break;
                case 'animation': endpoint = '/discover/movie'; params = { with_genres: 16, sort_by: 'popularity.desc', page: parseInt(page) }; break;
                default: endpoint = '/discover/movie'; params = { page: parseInt(page), sort_by: 'popularity.desc' };
            }
            const data = await tmdbFetch(endpoint, params);
            res.json({ success: true, data });
        } catch (error) {
            console.error(`❌ Content Error (${category}):`, error.message);
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    }
);

// GENRE DISCOVERY
app.get('/api/genre/:id',
    cacheMiddleware(cache.details, (req) => `genre:${req.params.id}:${JSON.stringify(req.query)}`),
    async (req, res) => {
        const { id } = req.params;
        const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
        try {
            const params = { page: parseInt(page), sort_by: sort, with_genres: id };
            if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
            if (year) {
                if (type === 'tv') params['first_air_date_year'] = parseInt(year);
                else params['primary_release_year'] = parseInt(year);
            }
            const data = await tmdbFetch(`/discover/${type}`, params);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
        }
    }
);

// GENRES
app.get('/api/genres/all', cacheMiddleware(cache.genres), async (req, res) => {
    try {
        const [movieGenres, tvGenres] = await Promise.all([tmdbFetch('/genre/movie/list'), tmdbFetch('/genre/tv/list')]);
        const merged = {};
        [...(movieGenres.genres || []), ...(tvGenres.genres || [])].forEach(g => { merged[g.id] = g.name; });
        res.json({ success: true, data: merged });
    } catch (error) {
        res.json({ success: true, data: {} });
    }
});

app.get('/api/genres',
    cacheMiddleware(cache.genres, (req) => `genres:${req.query.type || 'movie'}`),
    async (req, res) => {
        const { type = 'movie' } = req.query;
        try {
            const data = await tmdbFetch(`/genre/${type}/list`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { genres: [] } });
        }
    }
);

// DETAILS
app.get('/api/details/:type/:id',
    cacheMiddleware(cache.details, (req) => `details:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos,images,credits,similar,watch/providers,external_ids' });
            res.json({ success: true, data });
        } catch (error) {
            res.json({
                success: true,
                data: { id: parseInt(id), title: 'Unavailable', name: 'Unavailable', overview: "Sorry, we couldn't load details.", poster_path: null, backdrop_path: null, vote_average: 0, genres: [], credits: { cast: [] }, videos: { results: [] } }
            });
        }
    }
);

// SEARCH
app.get('/api/search',
    cacheMiddleware(cache.search, (req) => `search:${req.query.query}:${req.query.page || 1}`),
    async (req, res) => {
        const { query, page = 1 } = req.query;
        if (!query || query.length < 2) return res.json({ success: true, data: { results: [] } });
        try {
            const data = await tmdbFetch('/search/multi', { query, page: parseInt(page) });
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [] } });
        }
    }
);

// CREDITS
app.get('/api/credits/:type/:id',
    cacheMiddleware(cache.credits, (req) => `credits:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/credits`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { cast: [] } });
        }
    }
);

// EPISODES
app.get('/api/episodes/:tvId/:season',
    cacheMiddleware(cache.episodes, (req) => `episodes:${req.params.tvId}:${req.params.season}`),
    async (req, res) => {
        const { tvId, season } = req.params;
        try {
            const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { episodes: [] } });
        }
    }
);

// WATCH PROVIDERS
app.get('/api/providers/:type/:id',
    cacheMiddleware(cache.providers, (req) => `providers:${req.params.type}:${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: {} } });
        }
    }
);

// SIMILAR
app.get('/api/similar/:type/:id',
    cacheMiddleware(cache.similar, (req) => `similar:${req.params.type}:${req.params.id}:${req.query.page || 1}`),
    async (req, res) => {
        const { type, id } = req.params;
        const { page = 1 } = req.query;
        try {
            const data = await tmdbFetch(`/${type}/${id}/similar`, { page: parseInt(page) });
            res.json({ success: true, data });
        } catch (error) {
            res.json({ success: true, data: { results: [] } });
        }
    }
);

// ============ ENHANCED RECOMMENDATIONS ============

async function computeSimilarityScore(sourceItem, candidateItem) {
    const sourceGenres = new Set(sourceItem.genre_ids || (sourceItem.genres || []).map(g => g.id));
    const candidateGenres = new Set(candidateItem.genre_ids || (candidateItem.genres || []).map(g => g.id));
    const genreIntersection = [...sourceGenres].filter(g => candidateGenres.has(g)).length;
    const genreUnion = new Set([...sourceGenres, ...candidateGenres]).size;
    const genreScore = genreUnion > 0 ? genreIntersection / genreUnion : 0;

    const sourceYear = parseInt((sourceItem.release_date || sourceItem.first_air_date || '2000').split('-')[0]);
    const candidateYear = parseInt((candidateItem.release_date || candidateItem.first_air_date || '2000').split('-')[0]);
    const yearDiff = Math.abs(sourceYear - candidateYear);
    const yearScore = Math.max(0, 1 - (yearDiff / 20));

    const sourceRating = parseFloat(sourceItem.vote_average) || 5;
    const candidateRating = parseFloat(candidateItem.vote_average) || 5;
    const ratingDiff = Math.abs(sourceRating - candidateRating);
    const ratingScore = Math.max(0, 1 - (ratingDiff / 5));

    const popularityScore = Math.min(1, (candidateItem.vote_count || 0) / 1000);

    return (genreScore * 0.4) + (yearScore * 0.2) + (ratingScore * 0.2) + (popularityScore * 0.2);
}

async function getEnhancedRecommendations(id, type, userId = null) {
    try {
        const [sourceDetails, similar, recommendations] = await Promise.all([
            tmdbFetch(`/${type}/${id}`),
            tmdbFetch(`/${type}/${id}/similar`),
            tmdbFetch(`/${type}/${id}/recommendations`)
        ]);

        const allCandidates = [
            ...(similar.results || []).slice(0, 20),
            ...(recommendations.results || []).slice(0, 20)
        ];

        const uniqueCandidates = Array.from(new Map(allCandidates.map(item => [item.id, item])).values())
            .filter(item => item.id !== id);

        const scored = await Promise.all(
            uniqueCandidates.map(async (item) => {
                const score = await computeSimilarityScore(sourceDetails, item);
                return { ...item, score, media_type: type };
            })
        );

        scored.sort((a, b) => b.score - a.score);

        return {
            sourceId: id, sourceType: type,
            sourceTitle: sourceDetails.title || sourceDetails.name,
            recommendations: scored.slice(0, 20),
            generatedAt: new Date().toISOString()
        };
    } catch (error) {
        throw new Error(`Enhanced recommendations failed: ${error.message}`);
    }
}

app.get('/api/recommendations/enhanced/:type/:id',
    cacheMiddleware(cache.recommendations, (req) => `enhanced_rec_${req.params.type}_${req.params.id}`),
    async (req, res) => {
        const { type, id } = req.params;
        try {
            const result = await getEnhancedRecommendations(parseInt(id), type);
            res.json({ success: true, data: result });
        } catch (error) {
            res.json({ success: false, error: error.message, data: { recommendations: [] } });
        }
    }
);

app.get('/api/recommendations/batch', async (req, res) => {
    const { ids, type = 'movie' } = req.query;
    if (!ids) return res.json({ success: false, error: 'No IDs provided' });
    const movieIds = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    try {
        const results = await Promise.all(movieIds.map(async (id) => {
            try { return { id, ...(await getEnhancedRecommendations(id, type)) }; }
            catch (error) { return { id, error: error.message }; }
        }));
        res.json({ success: true, data: results });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/recommendations/cache/clear', (req, res) => {
    cache.recommendations.clear();
    res.json({ success: true, message: 'Recommendation cache cleared' });
});

// ============ START ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`\n✅ VIDSRC.ME embed endpoints:`);
    console.log(`   Movie (TMDB): GET /api/embed/movie/:tmdbId`);
    console.log(`   Movie (IMDB): GET /api/embed/movie/imdb/:imdbId`);
    console.log(`   TV (TMDB):    GET /api/embed/tv/:tmdbId/:season/:episode`);
    console.log(`   TV (IMDB):    GET /api/embed/tv/imdb/:imdbId/:season/:episode`);
    console.log(`\n✅ Trailer endpoint:`);
    console.log(`   GET /api/trailer/:type/:id  →  TMDB videos → YouTube fallback`);
    console.log(`\n✅ All TMDB endpoints active`);
});
