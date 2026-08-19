const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ API KEYS ============
// Set these as environment variables in production (Render, etc).
// Falling back to empty string so the server still boots without them,
// but TMDB/YouTube calls will fail until they're configured.
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

console.log('🚀 YOUFLEX Backend Server Starting...');

// ============ MIDDLEWARE ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ============ TMDB API HELPER ============
async function tmdbFetch(endpoint, params = {}, retries = 2) {
    const url = `https://api.themoviedb.org/3${endpoint}`;
    const allParams = { api_key: TMDB_API_KEY, ...params };

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                params: allParams,
                timeout: 15000,
                headers: { 'Accept': 'application/json', 'User-Agent': 'YOUFLEX/1.0' }
            });
            return response.data;
        } catch (error) {
            console.error(`❌ TMDB attempt ${attempt} failed for ${endpoint}:`, error.message);
            if (attempt === retries) return { results: [] };
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }
}

// ============ YOUTUBE API HELPER ============
async function youtubeFetch(endpoint, params = {}) {
    const url = `https://www.googleapis.com/youtube/v3${endpoint}`;
    const response = await axios.get(url, {
        params: { key: YOUTUBE_API_KEY, ...params },
        timeout: 15000
    });
    return response.data;
}

// ============ ROOT ============
app.get('/', (req, res) => {
    res.json({
        name: 'YOUFLEX API',
        version: '1.1.0',
        status: 'running',
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
            embedMovie: '/api/embed/movie/:imdbId',
            embedEpisode: '/api/embed/tv/:imdbId/:season/:episode'
        }
    });
});

// ============ HEALTH CHECK ============
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        services: {
            tmdb: TMDB_API_KEY ? 'configured' : 'not configured',
            youtube: YOUTUBE_API_KEY ? 'configured' : 'not configured'
        }
    });
});

// ============ EMBED MOVIE ============
app.get('/api/embed/movie/:imdbId', (req, res) => {
    const { imdbId } = req.params;
    
    // Validate IMDb ID format (starts with 'tt' followed by numbers)
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid IMDb ID format. Must start with "tt" followed by numbers.'
        });
    }

    const embedHtml = `
        <iframe src="https://vidsrc.hair/embed/movie/${imdbId}"
                width="100%" height="100%" frameborder="0"
                allowfullscreen></iframe>
    `;

    res.json({
        success: true,
        data: {
            imdbId: imdbId,
            embedUrl: `https://vidsrc.hair/embed/movie/${imdbId}`,
            html: embedHtml,
            type: 'movie'
        }
    });
});

// ============ EMBED TV EPISODE ============
app.get('/api/embed/tv/:imdbId/:season/:episode', (req, res) => {
    const { imdbId, season, episode } = req.params;
    
    // Validate IMDb ID format
    if (!imdbId || !/^tt\d+$/.test(imdbId)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid IMDb ID format. Must start with "tt" followed by numbers.'
        });
    }

    // Validate season and episode are numbers
    const seasonNum = parseInt(season);
    const episodeNum = parseInt(episode);
    
    if (isNaN(seasonNum) || isNaN(episodeNum) || seasonNum < 1 || episodeNum < 1) {
        return res.status(400).json({
            success: false,
            error: 'Season and episode must be positive integers.'
        });
    }

    const embedHtml = `
        <!-- ${imdbId}, season ${seasonNum}, episode ${episodeNum} -->
        <iframe src="https://vidsrc.hair/embed/tv/${imdbId}/${seasonNum}/${episodeNum}"
                width="100%" height="100%" frameborder="0"
                allowfullscreen></iframe>
    `;

    res.json({
        success: true,
        data: {
            imdbId: imdbId,
            season: seasonNum,
            episode: episodeNum,
            embedUrl: `https://vidsrc.hair/embed/tv/${imdbId}/${seasonNum}/${episodeNum}`,
            html: embedHtml,
            type: 'tv'
        }
    });
});

// ============ TRENDING (hero banner) ============
app.get('/api/trending', async (req, res) => {
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
app.get('/api/content/:category', async (req, res) => {
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

// ============ GENRE DISCOVERY (used by "fetchByGenre" on the frontend) ============
app.get('/api/genre/:id', async (req, res) => {
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
app.get('/api/genres/all', async (req, res) => {
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

app.get('/api/genres', async (req, res) => {
    const { type = 'movie' } = req.query;
    try {
        const data = await tmdbFetch(`/genre/${type}/list`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { genres: [] } });
    }
});

// ============ DETAILS ============
app.get('/api/details/:type/:id', async (req, res) => {
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
app.get('/api/search', async (req, res) => {
    const { query, page = 1 } = req.query;
    if (!query || query.length < 2) return res.json({ success: true, data: { results: [] } });
    try {
        const data = await tmdbFetch('/search/multi', { query, page: parseInt(page) });
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// ============ TRAILER (TMDB-hosted, YouTube video id only) ============
app.get('/api/trailer/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'videos' });
        const videos = data.videos?.results || [];

        const trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                         videos.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
                         videos.find(v => v.site === 'YouTube');

        if (trailer) {
            return res.json({
                success: true,
                data: {
                    key: trailer.key,
                    name: trailer.name,
                    embedUrl: `https://www.youtube.com/embed/${trailer.key}`,
                    embedUrlAutoplay: `https://www.youtube.com/embed/${trailer.key}?autoplay=1&rel=0&modestbranding=1`
                }
            });
        }
        res.json({ success: false, error: 'No trailer found', data: null });
    } catch (error) {
        console.error('❌ Trailer Error:', error.message);
        res.json({ success: false, error: error.message });
    }
});

// ============ YOUTUBE SEARCH (fallback trailer lookup) ============
app.get('/api/youtube/search', async (req, res) => {
    const { q, maxResults = 5 } = req.query;
    if (!q) return res.json({ success: false, error: 'Missing query', data: null });
    if (!YOUTUBE_API_KEY) return res.json({ success: false, error: 'YouTube API not configured', data: null });
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

// ============ YOUTUBE VIDEO DETAILS (views/likes for trailer modal) ============
app.get('/api/youtube/video/:id', async (req, res) => {
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
app.get('/api/credits/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}/credits`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { cast: [] } });
    }
});

// ============ EPISODES ============
app.get('/api/episodes/:tvId/:season', async (req, res) => {
    const { tvId, season } = req.params;
    try {
        const data = await tmdbFetch(`/tv/${tvId}/season/${season}`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { episodes: [] } });
    }
});

// ============ WATCH PROVIDERS (legitimate streaming availability) ============
app.get('/api/providers/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const data = await tmdbFetch(`/${type}/${id}/watch/providers`);
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: {} } });
    }
});

// ============ SIMILAR ============
app.get('/api/similar/:type/:id', async (req, res) => {
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
    console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing (set TMDB_API_KEY env var)'}`);
    console.log(`📡 YouTube API: ${YOUTUBE_API_KEY ? '✅ Configured' : '❌ Missing (set YOUTUBE_API_KEY env var)'}`);
    console.log(`🎬 Embed endpoints available:`);
    console.log(`   - Movie: /api/embed/movie/:imdbId`);
    console.log(`   - TV: /api/embed/tv/:imdbId/:season/:episode`);
});
