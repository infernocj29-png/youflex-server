const express = require('express');
const cors = require('cors');
const axios = require('axios');
const dns = require('dns');

const app = express();
const PORT = process.env.PORT || 3000;

// API Keys
const TMDB_API_KEY = '33ef7aaa3002731060f718f25dd995ac';
const YOUTUBE_API_KEY = 'AIzaSyCxCmXs4P4P8SenCmTlj5eawG4ccNP2FEg';

console.log('🚀 YOUFLEX Backend Server Starting...');
console.log('📡 TMDB API:', TMDB_API_KEY ? '✅ Configured' : '❌ Missing');
console.log('🎬 YouTube API:', YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' ? '✅ Configured' : '❌ Not configured');

// ============ DNS LOOKUP TEST ============
console.log('🔍 Checking DNS resolution...');
dns.lookup('api.themoviedb.org', (err, address) => {
    if (err) {
        console.error('❌ DNS Lookup failed for api.themoviedb.org:', err.message);
        console.log('💡 Try the following fixes:');
        console.log('   1. Restart your router');
        console.log('   2. Flush DNS: ipconfig /flushdns');
        console.log('   3. Use Google DNS: 8.8.8.8 and 8.8.4.4');
        console.log('   4. Check your internet connection');
        console.log('   5. Restart your computer');
    } else {
        console.log('✅ DNS Lookup successful:', address);
    }
});

// ============ MIDDLEWARE ============
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// ============ TMDB API WITH RETRY ============
async function tmdbFetch(endpoint, params = {}, retries = 3) {
    const url = `https://api.themoviedb.org/3${endpoint}`;
    const allParams = {
        api_key: TMDB_API_KEY,
        ...params
    };
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`🔄 Attempt ${attempt} for ${endpoint}`);
            const response = await axios.get(url, {
                params: allParams,
                timeout: 15000,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'YOUFLEX/1.0'
                }
            });
            console.log(`✅ Success: ${endpoint}`);
            return response.data;
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed:`, error.message);
            if (attempt === retries) {
                // Return fallback data
                console.log(`⚠️ Using fallback data for ${endpoint}`);
                return { results: [] };
            }
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        }
    }
}

// ============ ROOT ROUTE ============
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

// ============ HEALTH CHECK ============
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

// ============ TRENDING ============
app.get('/api/trending', async (req, res) => {
    try {
        console.log('📡 Fetching trending content...');
        
        // Use tmdbFetch with retry
        const [trending, upcoming, nowPlaying] = await Promise.all([
            tmdbFetch('/trending/all/day'),
            tmdbFetch('/movie/upcoming'),
            tmdbFetch('/movie/now_playing')
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
            ...formatItems(trending.results, 'trending'),
            ...formatItems(upcoming.results, 'upcoming', 'movie'),
            ...formatItems(nowPlaying.results, 'now-playing', 'movie')
        ];
        
        // If no items found, use fallback data
        if (heroItems.length === 0) {
            console.log('⚠️ No trending items found, using fallback data');
            return res.json({
                success: true,
                data: [{
                    id: 550,
                    title: "Fight Club",
                    name: "Fight Club",
                    media_type: "movie",
                    heroCategory: "trending",
                    backdrop_path: "/bptfVGEQuv6vDTIMVCHjJ9Dz8PX.jpg",
                    poster_path: "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
                    vote_average: 8.8,
                    overview: "A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.",
                    release_date: "1999-10-15"
                }]
            });
        }
        
        res.json({ success: true, data: heroItems });
    } catch (error) {
        console.error('❌ Trending Error:', error.message);
        // Return fallback data
        res.json({
            success: true,
            data: [{
                id: 550,
                title: "Fight Club",
                name: "Fight Club",
                media_type: "movie",
                heroCategory: "trending",
                backdrop_path: "/bptfVGEQuv6vDTIMVCHjJ9Dz8PX.jpg",
                poster_path: "/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg",
                vote_average: 8.8,
                overview: "A ticking-time-bomb insomniac and a slippery soap salesman channel primal male aggression into a shocking new form of therapy.",
                release_date: "1999-10-15"
            }]
        });
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
        
        const data = await tmdbFetch(endpoint, params);
        res.json({ success: true, data });
    } catch (error) {
        console.error(`❌ Content Error (${category}):`, error.message);
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
        [...(movieGenres.genres || []), ...(tvGenres.genres || [])].forEach(g => {
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
        console.error(`❌ Details Error:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SEARCH ============
app.get('/api/search', async (req, res) => {
    const { query, page = 1 } = req.query;
    if (!query || query.length < 2) {
        return res.json({ success: true, data: { results: [] } });
    }
    try {
        const data = await tmdbFetch('/search/multi', {
            query: query,
            page: parseInt(page)
        });
        res.json({ success: true, data });
    } catch (error) {
        res.json({ success: true, data: { results: [] } });
    }
});

// ============ TRAILER ============
app.get('/api/trailer/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        console.log(`🎬 Fetching trailer for ${type}/${id}`);
        const data = await tmdbFetch(`/${type}/${id}`, {
            append_to_response: 'videos'
        });
        const videos = data.videos?.results || [];
        
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
            const title = data.title || data.name;
            const year = (data.release_date || data.first_air_date || '').split('-')[0];
            
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

// ============ YOUTUBE API ============
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

// ============ YOUTUBE VIDEO DETAILS ============
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

// ============ PROVIDERS ============
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
    console.log(`📡 TMDB API: ${TMDB_API_KEY ? '✅ Configured' : '❌ Missing'}`);
    console.log(`🎬 YouTube API: ${YOUTUBE_API_KEY && YOUTUBE_API_KEY !== 'YOUR_YOUTUBE_API_KEY_HERE' ? '✅ Configured' : '❌ Not configured'}`);
    console.log(`\n💡 If you see DNS errors, try:`);
    console.log(`   1. Run: ipconfig /flushdns`);
    console.log(`   2. Use Google DNS (8.8.8.8)`);
    console.log(`   3. Restart your router`);
    console.log(`   4. Restart your computer`);
});
