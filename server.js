const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ API KEYS ============
const TMDB_API_KEY = process.env.TMDB_API_KEY || '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting...');

// ============ MIDDLEWARE ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ============ SERVER-SIDE CACHE ============
class Cache {
    constructor(ttl = 5 * 60 * 1000) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value) {
        this.cache.set(key, {
            value,
            timestamp: Date.now()
        });
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        return entry.value;
    }

    clear() {
        this.cache.clear();
    }

    getStats() {
        let total = 0;
        let expired = 0;
        for (const [key, entry] of this.cache) {
            total++;
            if (Date.now() - entry.timestamp > this.ttl) expired++;
        }
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
};

function cacheMiddleware(cacheInstance, keyGenerator = null) {
    return (req, res, next) => {
        const key = keyGenerator ? keyGenerator(req) : req.originalUrl;
        const cached = cacheInstance.get(key);
        
        if (cached) {
            res.setHeader('X-Cache', 'HIT');
            return res.json(cached);
        }
        
        const originalJson = res.json;
        res.json = function(data) {
            cacheInstance.set(key, data);
            res.setHeader('X-Cache', 'MISS');
            originalJson.call(this, data);
        };
        next();
    };
}

// ============ TMDB API HELPER WITH CACHE ============
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
            await new Promise(resolve => setTimeout(resolve, attempt * 500));
        }
    }
}

// ============ YOUTUBE API HELPER ============
const youtubeCache = new Cache(5 * 60 * 1000);

async function youtubeFetch(endpoint, params = {}) {
    const url = `https://www.googleapis.com/youtube/v3${endpoint}`;
    const cacheKey = `${endpoint}${JSON.stringify(params)}`;
    const cached = youtubeCache.get(cacheKey);
    if (cached) return cached;

    try {
        const response = await axios.get(url, {
            params: { key: YOUTUBE_API_KEY, ...params },
            timeout: 10000
        });
        youtubeCache.set(cacheKey, response.data);
        return response.data;
    } catch (error) {
        console.error('❌ YouTube API Error:', error.message);
        throw error;
    }
}

// ============ ROOT ============
app.get('/', (req, res) => {
    const cacheStats = {
        tmdb: tmdbCache.getStats(),
        youtube: youtubeCache.getStats(),
        endpoints: {
            trending: cache.trending.getStats(),
            details: cache.details.getStats(),
            search: cache.search.getStats(),
            genres: cache.genres.getStats(),
            credits: cache.credits.getStats(),
            similar: cache.similar.getStats(),
            providers: cache.providers.getStats(),
            episodes: cache.episodes.getStats(),
            youtube: cache.youtube.getStats(),
            embed: cache.embed.getStats()
        }
    };
    
    res.json({
        name: 'YOUFLEX API',
        version: '1.2.0',
        status: 'running',
        cache: cacheStats,
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
            embedMovie: '/api/embed/movie/:tmdbId',
            embedEpisode: '/api/embed/tv/:tmdbId/:season/:episode'
        }
    });
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    const cacheStats = {
        tmdb: tmdbCache.getStats(),
        youtube: youtubeCache.getStats()
    };
    
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        cache: cacheStats,
        services: {
            tmdb: TMDB_API_KEY ? 'configured' : 'not configured',
            youtube: YOUTUBE_API_KEY ? 'configured' : 'not configured'
        }
    });
});

// ============ UPDATED EMBED MOVIE - vidsrc.me ============
app.get('/api/embed/movie/:tmdbId', cacheMiddleware(cache.embed, (req) => `movie:${req.params.tmdbId}`), (req, res) => {
    const { tmdbId } = req.params;
    
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid TMDB ID format. Must be a number.'
        });
    }

    const embedUrl = `https://vidsrc.me/embed/movie?tmdb=${tmdbId}`;
    const embedHtml = `
        <iframe src="${embedUrl}"
                width="100%" height="100%" frameborder="0"
                allowfullscreen
                allow="autoplay; encrypted-media; fullscreen"
                referrerpolicy="strict-origin-when-cross-origin"></iframe>
    `;

    res.json({
        success: true,
        data: {
            tmdbId: tmdbId,
            embedUrl: embedUrl,
            html: embedHtml,
            type: 'movie'
        }
    });
});

// ============ UPDATED EMBED TV EPISODE - vidsrc.me ============
app.get('/api/embed/tv/:tmdbId/:season/:episode', cacheMiddleware(cache.embed, (req) => `tv:${req.params.tmdbId}:${req.params.season}:${req.params.episode}`), (req, res) => {
    const { tmdbId, season, episode } = req.params;
    
    if (!tmdbId || !/^\d+$/.test(tmdbId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid TMDB ID format. Must be a number.'
        });
    }

    const seasonNum = parseInt(season);
    const episodeNum = parseInt(episode);
    
    if (isNaN(seasonNum) || isNaN(episodeNum) || seasonNum < 1 || episodeNum < 1) {
        return res.status(400).json({
            success: false,
            error: 'Season and episode must be positive integers.'
        });
    }

    const embedUrl = `https://vidsrc.me/embed/tv?tmdb=${tmdbId}&season=${seasonNum}&episode=${episodeNum}`;
    const embedHtml = `
        <iframe src="${embedUrl}"
                width="100%" height="100%" frameborder="0"
                allowfullscreen
                allow="autoplay; encrypted-media; fullscreen"
                referrerpolicy="strict-origin-when-cross-origin"></iframe>
    `;

    res.json({
        success: true,
        data: {
            tmdbId: tmdbId,
            season: seasonNum,
            episode: episodeNum,
            embedUrl: embedUrl,
            html: embedHtml,
            type: 'tv'
        }
    });
});

// ============ TRENDING ============
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

// ============ CONTENT BY CATEGORY ============
app.get('/api/content/:category', cacheMiddleware(cache.details, (req) => `content:${req.params.category}:${JSON.stringify(req.query)}`), async (req, res) => {
    const { category } = req.params;
    const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;

    try {
        let endpoint = '/discover/movie';
        let params = { page: parseInt(page), sort_by: sort };

        if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
        if (year) params['primary_release_year'] = parseInt(year);

        switch (category) {
            case 'trending':
                endpoint = '/trending/all/week';
                params = { page: parseInt(page) };
                break;
            case 'tv':
                endpoint = '/discover/tv';
                break;
            case 'movie':
                endpoint = '/discover/movie';
                break;
            case 'upcoming':
                endpoint = '/movie/upcoming';
                params = { page: parseInt(page) };
                break;
            case 'now-playing':
                endpoint = '/movie/now_playing';
                params = { page: parseInt(page) };
                break;
            case 'top-rated':
                endpoint = `/discover/${type}`;
                params = { ...params, 'vote_count.gte': 200 };
                break;
            case 'anime':
                endpoint = '/discover/tv';
                params = { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc', page: parseInt(page) };
                break;
            case 'animation':
                endpoint = '/discover/movie';
                params = { with_genres: 16, sort_by: 'popularity.desc', page: parseInt(page) };
                break;
            default:
                endpoint = '/discover/movie';
                params = { page: parseInt(page), sort_by: 'popularity.desc' };
        }

        const data = await tmdbFetch(endpoint, params);
        res.json({ success: true, data });
    } catch (error) {
        console.error(`❌ Content Error (${category}):`, error.message);
        res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
    }
});

// ============ GENRE DISCOVERY ============
app.get('/api/genre/:id', cacheMiddleware(cache.details, (req) => `genre:${req.params.id}:${JSON.stringify(req.query)}`), async (req, res) => {
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
        console.error('❌ Genre Discovery Error:', error.message);
        res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
    }
});

// ============ GENRES ============
app.get('/api/genres/all', cacheMiddleware(cache.genres), async (req, res) => {
    try {
        const [movieGenres, tvGenres] = await Promise.all([
            tmdbFetch('/genre/movie/list'),
            tmdbFetch('/genre/tv/list')
        ]);
        const merged = {};
        [...(movieGenres.genres || []), ...(tvGenres.genres || [])].forEach(g => { merged[g.id] = g.name; });
        res.json({ success: true, data: merged });
    } catch (error) {
        res.json({ success: true, data: {} });
    }
});

app.get('/api/genres', cacheMiddleware(cache.genres, (req) => `genres:${req.query.type || 'movie'}`), async (req, res) => {
    const { type = 'movie' } = req.query;
    try {
        const data = await tmdbFetch(`/genre/${type}/list`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { genres: [] } });
    }
});

// ============ DETAILS ============
app.get('/api/details/:type/:id', cacheMiddleware(cache.details, (req) => `details:${req.params.type}:${req.params.id}`), async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}`, {
            append_to_response: 'videos,images,credits,similar,watch/providers'
        });
        res.json({ success: true, data });
    } catch (error) {
        console.error('❌ Details Error:', error.message);
        res.json({
            success: true,
            data: {
                id: parseInt(id),
                title: 'Unavailable',
                name: 'Unavailable',
                overview: "Sorry, we couldn't load the details for this title.",
                poster_path: null,
                backdrop_path: null,
                vote_average: 0,
                genres: [],
                credits: { cast: [] },
                videos: { results: [] }
            }
        });
    }
});

// ============ SEARCH ============
app.get('/api/search', cacheMiddleware(cache.search, (req) => `search:${req.query.query}:${req.query.page || 1}`), async (req, res) => {
    const { query, page = 1 } = req.query;
    if (!query || query.length < 2) return res.json({ success: true, data: { results: [] } });
    try {
        const data = await tmdbFetch('/search/multi', { query, page: parseInt(page) });
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// ============ TRAILER ============
app.get('/api/trailer/:type/:id', cacheMiddleware(cache.youtube, (req) => `trailer:${req.params.type}:${req.params.id}`), async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];

        // Try to find the best trailer
        const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                         videos.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
                         videos.find(v => v.site === 'YouTube');

        if (trailer && trailer.key) {
            return res.json({
                success: true,
                data: {
                    key: trailer.key,
                    name: trailer.name || 'Official Trailer',
                    embedUrl: `https://www.youtube.com/embed/${trailer.key}`,
                    embedUrlAutoplay: `https://www.youtube.com/embed/${trailer.key}?autoplay=1&rel=0&modestbranding=1`
                }
            });
        }
        
        // No trailer found
        res.json({ 
            success: false, 
            error: 'No trailer found',
            data: null 
        });
    } catch (error) {
        console.error('❌ Trailer Error:', error.message);
        res.json({ 
            success: false, 
            error: error.message,
            data: null 
        });
    }
});

// ============ YOUTUBE SEARCH ============
app.get('/api/youtube/search', cacheMiddleware(cache.youtube, (req) => `ytsearch:${req.query.q}:${req.query.maxResults || 5}`), async (req, res) => {
    const { q, maxResults = 5 } = req.query;
    if (!q) return res.json({ success: false, error: 'Missing query', data: null });
    if (!YOUTUBE_API_KEY) {
        return res.json({ success: false, error: 'YouTube API not configured', data: null });
    }
    try {
        const data = await youtubeFetch('/search', {
            part: 'snippet',
            q,
            maxResults: parseInt(maxResults),
            type: 'video',
            videoEmbeddable: 'true'
        });
        const items = (data.items || []).map(item => ({
            id: item.id.videoId,
            title: item.snippet.title,
            channelTitle: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails?.medium?.url || ''
        }));
        res.json({ success: true, data: { items } });
    } catch (error) {
        console.error('❌ YouTube Search Error:', error.message);
        res.json({ success: false, error: error.message, data: null });
    }
});

// ============ YOUTUBE VIDEO DETAILS ============
app.get('/api/youtube/video/:id', cacheMiddleware(cache.youtube, (req) => `ytvideo:${req.params.id}`), async (req, res) => {
    const { id } = req.params;
    if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
    try {
        const data = await youtubeFetch('/videos', { part: 'statistics,snippet', id });
        const video = (data.items || [])[0];
        if (!video) return res.json({ success: false, error: 'Video not found', data: null });
        res.json({
            success: true,
            data: {
                viewCount: video.statistics?.viewCount,
                likeCount: video.statistics?.likeCount,
                channelTitle: video.snippet?.channelTitle
            }
        });
    } catch (error) {
        console.error('❌ YouTube Video Error:', error.message);
        res.json({ success: false, error: error.message, data: null });
    }
});

// ============ CREDITS ============
app.get('/api/credits/:type/:id', cacheMiddleware(cache.credits, (req) => `credits:${req.params.type}:${req.params.id}`), async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}/credits`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { cast: [] } });
    }
});

// ============ EPISODES ============
app.get('/api/episodes/:tvId/:season', cacheMiddleware(cache.episodes, (req) => `episodes:${req.params.tvId}:${req.params.season}`), async (req, res) => {
    const { tvId, season } = req.params;
    try {
        const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { episodes: [] } });
    }
});

// ============ WATCH PROVIDERS ============
app.get('/api/providers/:type/:id', cacheMiddleware(cache.providers, (req) => `providers:${req.params.type}:${req.params.id}`), async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: {} } });
    }
});

// ============ SIMILAR ============
app.get('/api/similar/:type/:id', cacheMiddleware(cache.similar, (req) => `similar:${req.params.type}:${req.params.id}:${req.query.page || 1}`), async (req, res) => {
    const { type, id } = req.params;
    const { page = 1 } = req.query;
    try {
        const data = await tmdbFetch(`/${type}/${id}/similar`, { page: parseInt(page) });
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// ============ START SERVER ============
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend Server running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`📡 YouTube API: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`📦 Server-side caching enabled with 5-30 minute TTL`);
    console.log(`🎬 Embed endpoints available (vidsrc.me):`);
    console.log(`   - Movie: /api/embed/movie/:tmdbId`);
    console.log(`   - TV: /api/embed/tv/:tmdbId/:season/:episode`);
});
