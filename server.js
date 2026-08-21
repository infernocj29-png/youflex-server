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
    recommendations: new Cache(30 * 60 * 1000),
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

// ============ ENHANCED SIMILARITY SYSTEM ============

/**
 * Extract keywords from movie overview and metadata
 */
function extractKeywords(movie) {
    const keywords = new Set();
    const overview = (movie.overview || '').toLowerCase();
    const title = (movie.title || movie.name || '').toLowerCase();
    
    // Common thematic keywords
    const themeKeywords = {
        'space': ['space', 'astronaut', 'planet', 'galaxy', 'alien', 'solar', 'orbit', 'interstellar', 'cosmos'],
        'survival': ['survive', 'survival', 'stranded', 'desert', 'island', 'apocalypse', 'post-apocalyptic'],
        'war': ['war', 'battle', 'soldier', 'army', 'military', 'fight', 'combat', 'invasion'],
        'revenge': ['revenge', 'vengeance', 'avenge', 'retribution', 'payback'],
        'crime': ['crime', 'murder', 'detective', 'investigation', 'case', 'mystery', 'killer', 'serial'],
        'supernatural': ['supernatural', 'ghost', 'paranormal', 'haunted', 'demon', 'exorcism', 'spirit'],
        'romance': ['love', 'romantic', 'romance', 'dating', 'marriage', 'wedding', 'relationship'],
        'comedy': ['funny', 'comedy', 'humor', 'laugh', 'joke', 'hilarious'],
        'action': ['action', 'explosive', 'chase', 'fight', 'gun', 'assassin', 'agent', 'spy'],
        'dystopian': ['dystopia', 'dystopian', 'future', 'society', 'totalitarian', 'freedom'],
        'time_travel': ['time travel', 'temporal', 'past', 'future', 'timeline', 'paradox'],
        'monsters': ['monster', 'creature', 'beast', 'giant', 'dinosaur', 'mutant'],
        'family': ['family', 'father', 'mother', 'son', 'daughter', 'parent', 'child', 'sibling'],
        'adventure': ['adventure', 'quest', 'exploration', 'journey', 'treasure', 'discover'],
        'magic': ['magic', 'wizard', 'sorcerer', 'spell', 'fantasy', 'dragon', 'elf'],
        'sci_fi': ['science', 'scientific', 'futuristic', 'robot', 'cyborg', 'clone', 'cyberpunk'],
        'thriller': ['thriller', 'suspense', 'intense', 'psychological', 'mystery'],
        'heist': ['heist', 'robbery', 'bank', 'thief', 'steal', 'criminal'],
        'biography': ['biography', 'biopic', 'true story', 'real life', 'historical'],
        'sports': ['sport', 'athlete', 'team', 'game', 'champion', 'competition']
    };
    
    // Check overview for keywords
    for (const [category, words] of Object.entries(themeKeywords)) {
        for (const word of words) {
            if (overview.includes(word) || title.includes(word)) {
                keywords.add(category);
                break;
            }
        }
    }
    
    // Extract potential keywords from overview
    const commonWords = ['the', 'a', 'an', 'of', 'to', 'for', 'on', 'with', 'by', 'from', 'at', 'in', 'and', 'or', 'but', 'so', 'for', 'nor', 'yet', 'as', 'if', 'then', 'else', 'when', 'where', 'which', 'what', 'who', 'whom', 'whose', 'that', 'this', 'these', 'those'];
    const words = overview.split(/\s+/);
    for (const word of words) {
        const clean = word.replace(/[^a-z]/g, '');
        if (clean.length > 4 && !commonWords.includes(clean) && !keywords.has(clean)) {
            keywords.add(clean);
        }
    }
    
    return Array.from(keywords);
}

/**
 * Calculate text similarity using cosine similarity
 */
function calculateTextSimilarity(text1, text2) {
    if (!text1 || !text2) return 0;
    
    const words1 = text1.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const words2 = text2.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    const common = words1.filter(w => words2.includes(w));
    const similarity = common.length / Math.sqrt(words1.length * words2.length);
    
    return Math.min(similarity, 1);
}

/**
 * Calculate genre similarity between two movies
 */
function calculateGenreSimilarity(genres1, genres2) {
    if (!genres1 || !genres2 || genres1.length === 0 || genres2.length === 0) return 0;
    
    const set1 = new Set(genres1);
    const set2 = new Set(genres2);
    
    let matches = 0;
    for (const genre of set1) {
        if (set2.has(genre)) matches++;
    }
    
    const total = Math.min(set1.size + set2.size, 16);
    return matches / total;
}

/**
 * Calculate cast similarity with weighted importance
 */
function calculateCastSimilarity(cast1, cast2) {
    if (!cast1 || !cast2 || cast1.length === 0 || cast2.length === 0) return 0;
    
    const set1 = new Set(cast1.slice(0, 10));
    const set2 = new Set(cast2.slice(0, 10));
    
    let matches = 0;
    for (const actor of set1) {
        if (set2.has(actor)) matches++;
    }
    
    return matches / Math.min(set1.size, set2.size);
}

/**
 * Calculate director similarity
 */
function calculateDirectorSimilarity(crew1, crew2) {
    const dir1 = crew1?.find(c => c.job === 'Director')?.id;
    const dir2 = crew2?.find(c => c.job === 'Director')?.id;
    
    if (!dir1 || !dir2) return 0;
    return dir1 === dir2 ? 1 : 0;
}

/**
 * Calculate franchise similarity
 */
function calculateFranchiseSimilarity(movie1, movie2) {
    const collection1 = movie1.belongs_to_collection?.id;
    const collection2 = movie2.belongs_to_collection?.id;
    
    if (collection1 && collection2 && collection1 === collection2) {
        return 1;
    }
    
    // Check series/sequel similarity
    const title1 = (movie1.title || movie1.name || '').toLowerCase();
    const title2 = (movie2.title || movie2.name || '').toLowerCase();
    
    // Check for common franchise patterns
    const franchiseWords = ['chapter', 'part', 'episode', 'series', 'saga', 'chronicle', 'beyond', 'returns', 'revenge', 'legacy'];
    for (const word of franchiseWords) {
        if (title1.includes(word) && title2.includes(word)) return 0.5;
    }
    
    return 0;
}

/**
 * Calculate era similarity (release year proximity)
 */
function calculateEraSimilarity(year1, year2) {
    if (!year1 || !year2) return 0;
    const diff = Math.abs(year1 - year2);
    if (diff <= 2) return 1;
    if (diff <= 5) return 0.8;
    if (diff <= 10) return 0.5;
    if (diff <= 20) return 0.3;
    return 0.1;
}

/**
 * Calculate language similarity
 */
function calculateLanguageSimilarity(lang1, lang2) {
    if (!lang1 || !lang2) return 0.5;
    return lang1 === lang2 ? 1 : 0.3;
}

/**
 * Calculate keyword similarity using both TMDB keywords and text analysis
 */
function calculateKeywordSimilarity(sourceKeywords, targetKeywords, sourceOverview, targetOverview) {
    // TMDB keyword overlap
    const keywordOverlap = sourceKeywords.filter(k => targetKeywords.includes(k));
    const keywordScore = sourceKeywords.length > 0 ? keywordOverlap.length / sourceKeywords.length : 0;
    
    // Text-based keyword extraction
    const sourceTextKeywords = extractKeywords({ overview: sourceOverview });
    const targetTextKeywords = extractKeywords({ overview: targetOverview });
    
    const textOverlap = sourceTextKeywords.filter(k => targetTextKeywords.includes(k));
    const textScore = sourceTextKeywords.length > 0 ? textOverlap.length / sourceTextKeywords.length : 0;
    
    // Combine both signals
    return Math.max(keywordScore, textScore * 0.8);
}

/**
 * Calculate similarity score between two movies
 */
async function calculateSimilarityScore(source, target, context) {
    const {
        sourceGenres,
        sourceKeywords,
        sourceCast,
        sourceCrew,
        sourceOverview,
        sourceYear,
        sourceLang,
        sourceTitle
    } = context;
    
    // Extract target metadata
    const targetGenres = target.genres?.map(g => g.id) || [];
    const targetKeywords = target.keywords?.keywords?.map(k => k.id) || [];
    const targetCast = target.credits?.cast?.slice(0, 15).map(c => c.id) || [];
    const targetCrew = target.credits?.crew || [];
    const targetOverview = target.overview || '';
    const targetYear = target.release_date ? new Date(target.release_date).getFullYear() : null;
    const targetLang = target.original_language || 'en';
    const targetTitle = target.title || target.name || '';
    
    // 1. Genre Similarity (25%)
    const genreScore = calculateGenreSimilarity(sourceGenres, targetGenres);
    
    // 2. Keyword/Themes Similarity (25%)
    const keywordScore = calculateKeywordSimilarity(sourceKeywords, targetKeywords, sourceOverview, targetOverview);
    
    // 3. Plot/Overview Similarity (20%)
    const plotScore = calculateTextSimilarity(sourceOverview, targetOverview);
    
    // 4. Cast Similarity (10%)
    const castScore = calculateCastSimilarity(sourceCast, targetCast);
    
    // 5. Director Similarity (5%)
    const directorScore = calculateDirectorSimilarity(sourceCrew, targetCrew);
    
    // 6. Franchise Similarity (5%)
    const franchiseScore = calculateFranchiseSimilarity(source, target);
    
    // 7. Rating Quality (5%)
    const ratingScore = Math.min((target.vote_average || 0) / 10, 1);
    
    // 8. Popularity (3%)
    const popularityScore = Math.min((target.popularity || 0) / 100, 1);
    
    // 9. Release Era & Language (2%)
    const eraScore = calculateEraSimilarity(sourceYear, targetYear);
    const langScore = calculateLanguageSimilarity(sourceLang, targetLang);
    const eraLangScore = (eraScore + langScore) / 2;
    
    // Calculate weighted total
    const totalScore = (
        genreScore * 0.25 +
        keywordScore * 0.25 +
        plotScore * 0.20 +
        castScore * 0.10 +
        directorScore * 0.05 +
        franchiseScore * 0.05 +
        ratingScore * 0.05 +
        popularityScore * 0.03 +
        eraLangScore * 0.02
    );
    
    // Apply genre boost for exact genre matches
    const exactGenreMatch = sourceGenres.length > 0 && targetGenres.length > 0 &&
        sourceGenres.some(g => targetGenres.includes(g));
    
    const finalScore = exactGenreMatch ? Math.min(totalScore * 1.1, 1) : totalScore;
    
    return Math.round(finalScore * 100) / 100;
}

/**
 * Apply diversity to recommendations
 */
function applyDiversity(candidates, maxCount = 10) {
    if (candidates.length <= maxCount) return candidates.slice(0, maxCount);
    
    const diverse = [];
    const usedGenres = new Set();
    
    // Always include the top recommendation
    diverse.push(candidates[0]);
    if (candidates[0]._details?.genres) {
        candidates[0]._details.genres.forEach(g => usedGenres.add(g.id));
    }
    
    // Add diverse recommendations
    for (let i = 1; i < candidates.length && diverse.length < maxCount; i++) {
        const candidate = candidates[i];
        const candidateGenres = candidate._details?.genres || [];
        
        // Check if this candidate brings new genres
        const newGenres = candidateGenres.filter(g => !usedGenres.has(g.id));
        if (newGenres.length >= 1 || diverse.length < 3) {
            diverse.push(candidate);
            candidateGenres.forEach(g => usedGenres.add(g.id));
        }
    }
    
    // Fill remaining slots with highest scored if needed
    if (diverse.length < maxCount) {
        for (const candidate of candidates) {
            if (!diverse.includes(candidate) && diverse.length < maxCount) {
                diverse.push(candidate);
            }
        }
    }
    
    return diverse;
}

/**
 * Enhanced recommendation engine with multi-factor scoring
 */
async function getEnhancedRecommendations(movieId, type, userId = null) {
    const cacheKey = `enhanced_recommendations_${type}_${movieId}_${userId || 'anonymous'}`;
    const cached = cache.recommendations.get(cacheKey);
    if (cached) {
        console.log('📦 Using cached recommendations for:', movieId);
        return cached;
    }
    
    console.log('🔍 Generating enhanced recommendations for:', movieId);
    
    try {
        // Fetch source movie details
        const sourceMovie = await tmdbFetch(`/${type}/${movieId}`, {
            append_to_response: 'credits,keywords'
        });
        
        if (!sourceMovie || !sourceMovie.id) {
            return { success: false, error: 'Movie not found' };
        }
        
        // Extract source movie metadata
        const sourceGenres = sourceMovie.genres?.map(g => g.id) || [];
        const sourceKeywords = sourceMovie.keywords?.keywords?.map(k => k.id) || [];
        const sourceCast = sourceMovie.credits?.cast?.slice(0, 15).map(c => c.id) || [];
        const sourceCrew = sourceMovie.credits?.crew || [];
        const sourceOverview = sourceMovie.overview || '';
        const sourceYear = sourceMovie.release_date ? new Date(sourceMovie.release_date).getFullYear() : null;
        const sourceLang = sourceMovie.original_language || 'en';
        const sourceTitle = sourceMovie.title || sourceMovie.name;
        
        // Get potential candidates - use multiple sources
        const [similarMovies, genreMovies, keywordMovies] = await Promise.all([
            tmdbFetch(`/${type}/${movieId}/similar`, { page: 1 }),
            sourceGenres.length > 0 ? tmdbFetch(`/discover/${type}`, {
                with_genres: sourceGenres.slice(0, 3).join(','),
                sort_by: 'popularity.desc',
                page: 1,
                vote_count_gte: 100
            }) : { results: [] },
            sourceKeywords.length > 0 ? tmdbFetch(`/discover/${type}`, {
                with_keywords: sourceKeywords.slice(0, 5).join(','),
                sort_by: 'popularity.desc',
                page: 1
            }) : { results: [] }
        ]);
        
        // Combine candidates, deduplicate, and exclude source movie
        const candidateMap = new Map();
        const allCandidates = [...(similarMovies.results || []), ...(genreMovies.results || []), ...(keywordMovies.results || [])];
        
        for (const movie of allCandidates) {
            if (movie.id === sourceMovie.id) continue;
            if (candidateMap.has(movie.id)) continue;
            
            // Fetch additional details for scoring
            try {
                const details = await tmdbFetch(`/${type}/${movie.id}`, {
                    append_to_response: 'credits,keywords'
                });
                
                const score = await calculateSimilarityScore(sourceMovie, details, {
                    sourceGenres,
                    sourceKeywords,
                    sourceCast,
                    sourceCrew,
                    sourceOverview,
                    sourceYear,
                    sourceLang,
                    sourceTitle
                });
                
                candidateMap.set(movie.id, {
                    ...movie,
                    _details: details,
                    _score: score
                });
            } catch (error) {
                console.warn('⚠️ Could not fetch details for candidate:', movie.id);
                // Use minimal data
                candidateMap.set(movie.id, {
                    ...movie,
                    _score: 0.1
                });
            }
        }
        
        // Score and sort candidates
        const scoredCandidates = Array.from(candidateMap.values())
            .filter(c => c._score > 0.15) // Minimum threshold
            .sort((a, b) => b._score - a._score);
        
        // Apply diversity - don't show too many similar movies
        const diverseResults = applyDiversity(scoredCandidates, 10);
        
        const result = {
            source: {
                id: sourceMovie.id,
                title: sourceTitle,
                year: sourceYear,
                genres: sourceGenres
            },
            recommendations: diverseResults.map(item => ({
                id: item.id,
                title: item.title || item.name,
                poster_path: item.poster_path,
                vote_average: item.vote_average,
                release_date: item.release_date || item.first_air_date,
                overview: item.overview,
                media_type: type,
                score: item._score
            })),
            total_candidates: scoredCandidates.length
        };
        
        // Cache the result
        cache.recommendations.set(cacheKey, result);
        return result;
        
    } catch (error) {
        console.error('❌ Enhanced recommendation error:', error);
        return { success: false, error: error.message };
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
            embed: cache.embed.getStats(),
            recommendations: cache.recommendations.getStats()
        }
    };
    
    res.json({
        name: 'YOUFLEX API',
        version: '1.3.0',
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
            embedEpisode: '/api/embed/tv/:tmdbId/:season/:episode',
            recommendationsEnhanced: '/api/recommendations/enhanced/:type/:id',
            recommendationsBatch: '/api/recommendations/batch',
            recommendationsCacheClear: '/api/recommendations/cache/clear'
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

// ============ ENHANCED RECOMMENDATIONS API ============

app.get('/api/recommendations/enhanced/:type/:id', cacheMiddleware(cache.recommendations, (req) => `enhanced_rec_${req.params.type}_${req.params.id}_${req.query.userId || 'anonymous'}`), async (req, res) => {
    const { type, id } = req.params;
    const { userId } = req.query;
    
    try {
        const result = await getEnhancedRecommendations(parseInt(id), type, userId);
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('❌ Enhanced recommendations error:', error);
        res.json({ 
            success: false, 
            error: error.message,
            data: { recommendations: [] }
        });
    }
});

// ============ BATCH RECOMMENDATIONS FOR HOMEPAGE ============

app.get('/api/recommendations/batch', async (req, res) => {
    const { ids, type = 'movie' } = req.query;
    
    if (!ids) {
        return res.json({ success: false, error: 'No IDs provided' });
    }
    
    const movieIds = ids.split(',').map(id => parseInt(id)).filter(id => !isNaN(id));
    
    try {
        const results = await Promise.all(
            movieIds.map(async (id) => {
                try {
                    const result = await getEnhancedRecommendations(id, type);
                    return { id, ...result };
                } catch (error) {
                    return { id, error: error.message };
                }
            })
        );
        
        res.json({ success: true, data: results });
    } catch (error) {
        console.error('❌ Batch recommendations error:', error);
        res.json({ success: false, error: error.message });
    }
});

// ============ RECOMMENDATION CACHE CLEAR ============

app.post('/api/recommendations/cache/clear', (req, res) => {
    cache.recommendations.clear();
    res.json({ success: true, message: 'Recommendation cache cleared' });
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
    console.log(`🎯 Enhanced recommendations available:`);
    console.log(`   - Single: /api/recommendations/enhanced/:type/:id`);
    console.log(`   - Batch: /api/recommendations/batch?ids=1,2,3`);
});
