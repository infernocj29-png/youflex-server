const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const TMDB_API_KEY = '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting...');
console.log('📡 TMDB API:', TMDB_API_KEY ? '✅ Configured' : '❌ Missing');
console.log('🎬 YouTube API:', YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' ? '✅ Configured' : '❌ Not configured');

// Middleware
app.use(cors());
app.use(express.json());

// Root route
app.get('/', (req, res) => {
    res.json({
        name: 'YOUFLEX API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: '/api/health',
            trending: '/api/trending',
            content: '/api/content/:category',
            details: '/api/details/:type/:id',
            trailer: '/api/trailer/:type/:id',
            search: '/api/search?query=...',
            youtube: '/api/youtube/search?q=...'
        }
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        services: {
            tmdb: TMDB_API_KEY ? 'connected' : 'not configured',
            youtube: YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' ? 'configured' : 'not configured'
        }
    });
});

// Trending
app.get('/api/trending', async (req, res) => {
    try {
        console.log('📡 Fetching trending content...');
        const [trending, upcoming, nowPlaying] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/trending/all/day?api_key=${TMDB_API_KEY}`).catch(() => ({ data: { results: [] } })),
            axios.get(`https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API_KEY}`).catch(() => ({ data: { results: [] } })),
            axios.get(`https://api.themoviedb.org/3/movie/now_playing?api_key=${TMDB_API_KEY}`).catch(() => ({ data: { results: [] } }))
        ]);
        
        const formatItems = (items, category, mediaType) => {
            return (items || [])
                .filter(item => item.backdrop_path && item.media_type !== 'person')
                .slice(0, 4)
                .map(item => ({
                    ...item,
                    media_type: mediaType || item.media_type || 'movie',
                    heroCategory: category
                }));
        };
        
        const heroItems = [
            ...formatItems(trending.data.results, 'trending'),
            ...formatItems(upcoming.data.results, 'upcoming', 'movie'),
            ...formatItems(nowPlaying.data.results, 'now-playing', 'movie')
        ];
        
        res.json({ success: true, data: heroItems });
    } catch (error) {
        console.error('❌ Trending Error:', error.message);
        res.json({ success: true, data: [] });
    }
});

// Content by category
app.get('/api/content/:category', async (req, res) => {
    const { category } = req.params;
    const { page = 1, sort = 'popularity.desc', rating = 0, year = '', type = 'movie' } = req.query;
    
    try {
        let endpoint = '/discover/movie';
        let params = { page: parseInt(page), sort_by: sort };
        
        if (rating > 0) params['vote_average.gte'] = parseFloat(rating);
        if (year) params['primary_release_year'] = parseInt(year);
        
        switch(category) {
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
        
        const response = await axios.get(`https://api.themoviedb.org/3${endpoint}?api_key=${TMDB_API_KEY}`, { params });
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error(`❌ Content Error (${category}):`, error.message);
        res.json({ success: true, data: { results: [], page: 1, total_pages: 0 } });
    }
});

// Genres
app.get('/api/genres/all', async (req, res) => {
    try {
        const [movieGenres, tvGenres] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/genre/movie/list?api_key=${TMDB_API_KEY}`),
            axios.get(`https://api.themoviedb.org/3/genre/tv/list?api_key=${TMDB_API_KEY}`)
        ]);
        
        const merged = {};
        [...(movieGenres.data.genres || []), ...(tvGenres.data.genres || [])].forEach(g => {
            merged[g.id] = g.name;
        });
        
        res.json({ success: true, data: merged });
    } catch (error) {
        res.json({ success: true, data: {} });
    }
});

app.get('/api/genres', async (req, res) => {
    const { type = 'movie' } = req.query;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/genre/${type}/list?api_key=${TMDB_API_KEY}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { genres: [] } });
    }
});

// Details
app.get('/api/details/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&append_to_response=videos,images,credits,similar,watch/providers`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error(`❌ Details Error:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Search
app.get('/api/search', async (req, res) => {
    const { query, page = 1 } = req.query;
    if (!query || query.length < 2) {
        return res.json({ success: true, data: { results: [] } });
    }
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// ===== FIXED TRAILER ENDPOINT =====
app.get('/api/trailer/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        console.log(`🎬 Fetching trailer for ${type}/${id}`);
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&append_to_response=videos`);
        const videos = response.data.videos?.results || [];
        
        // Find trailer
        let trailer = videos.find(v => v.site === 'YouTube' && v.type === 'Trailer') ||
                     videos.find(v => v.site === 'YouTube' && v.type === 'Teaser') ||
                     videos.find(v => v.site === 'YouTube');
        
        if (trailer) {
            console.log(`✅ Found trailer in TMDB: ${trailer.key}`);
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
        
        // YouTube API fallback
        if (YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE') {
            const title = response.data.title || response.data.name;
            const year = (response.data.release_date || response.data.first_air_date || '').split('-')[0];
            
            const queries = [
                `${title} ${year} official trailer`,
                `${title} official trailer`,
                `${title} trailer`
            ];
            
            for (const query of queries) {
                try {
                    console.log(`🔍 Searching YouTube: ${query}`);
                    const youtubeResponse = await axios.get(`https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&q=${encodeURIComponent(query)}&part=snippet&maxResults=3&type=video&videoEmbeddable=true`);
                    
                    if (youtubeResponse.data.items && youtubeResponse.data.items.length > 0) {
                        const video = youtubeResponse.data.items[0];
                        console.log(`✅ Found trailer on YouTube: ${video.id.videoId}`);
                        return res.json({
                            success: true,
                            data: {
                                key: video.id.videoId,
                                name: video.snippet.title,
                                embedUrl: `https://www.youtube.com/embed/${video.id.videoId}`,
                                embedUrlAutoplay: `https://www.youtube.com/embed/${video.id.videoId}?autoplay=1&rel=0&modestbranding=1`
                            }
                        });
                    }
                } catch (e) { 
                    console.log(`YouTube search failed for: ${query}`);
                    continue; 
                }
            }
        }
        
        console.log(`❌ No trailer found for ${type}/${id}`);
        res.json({ success: false, error: 'No trailer found' });
    } catch (error) {
        console.error('❌ Trailer Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// YouTube Search
app.get('/api/youtube/search', async (req, res) => {
    const { q, maxResults = 5 } = req.query;
    console.log(`🔍 YouTube search: ${q}`);
    
    if (!q || q.length < 2 || !YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
        return res.json({ success: true, data: { items: [] } });
    }
    try {
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&q=${encodeURIComponent(q)}&part=snippet&maxResults=${maxResults}&type=video&videoEmbeddable=true`);
        
        if (response.data.items) {
            const videos = response.data.items.map(item => ({
                id: item.id.videoId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.high?.url || item.snippet.thumbnails.default?.url,
                channelTitle: item.snippet.channelTitle,
                embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`
            }));
            console.log(`✅ YouTube search returned ${videos.length} results`);
            res.json({ success: true, data: { items: videos } });
        } else {
            res.json({ success: true, data: { items: [] } });
        }
    } catch (error) {
        console.error('❌ YouTube Search Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// YouTube Video Details
app.get('/api/youtube/video/:id', async (req, res) => {
    const { id } = req.params;
    console.log(`🎬 Getting YouTube video details: ${id}`);
    
    if (!YOUTUBE_API_KEY || YOUTUBE_API_KEY === 'YOUR_YOUTUBE_API_KEY_HERE') {
        return res.json({ success: false, error: 'YouTube API not configured' });
    }
    try {
        const response = await axios.get(`https://www.googleapis.com/youtube/v3/videos?key=${YOUTUBE_API_KEY}&id=${id}&part=snippet,statistics,contentDetails`);
        
        if (response.data.items && response.data.items.length > 0) {
            const video = response.data.items[0];
            res.json({
                success: true,
                data: {
                    id: video.id,
                    title: video.snippet.title,
                    channelTitle: video.snippet.channelTitle,
                    viewCount: video.statistics?.viewCount || '0',
                    likeCount: video.statistics?.likeCount || '0',
                    embedUrl: `https://www.youtube.com/embed/${video.id}`
                }
            });
        } else {
            res.json({ success: false, error: 'Video not found' });
        }
    } catch (error) {
        console.error('❌ YouTube Video Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Credits
app.get('/api/credits/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/credits?api_key=${TMDB_API_KEY}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { cast: [] } });
    }
});

// Episodes
app.get('/api/episodes/:tvId/:season', async (req, res) => {
    const { tvId, season } = req.params;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/tv/${tvId}/season/${season}?api_key=${TMDB_API_KEY}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { episodes: [] } });
    }
});

// Providers
app.get('/api/providers/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/watch/providers?api_key=${TMDB_API_KEY}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { results: {} } });
    }
});

// Similar
app.get('/api/similar/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    const { page = 1 } = req.query;
    try {
        const response = await axios.get(`https://api.themoviedb.org/3/${type}/${id}/similar?api_key=${TMDB_API_KEY}&page=${page}`);
        res.json({ success: true, data: response.data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 YOUFLEX Backend Server running on port ${PORT}`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`🎬 YouTube API: ${YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' ? '✅ Configured' : '❌ Not configured'}`);
});
