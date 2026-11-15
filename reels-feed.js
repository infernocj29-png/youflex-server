// ============================================================
// YOUFLEX REELS FEED  —  GET /api/clips/feed
// An endless, mixed feed of verified-embeddable official clips.
//
// Each call returns ~12 clips plus an opaque `next` cursor. The cursor walks
// through many TMDB result pages across many sources (trending, action, comedy,
// drama, thriller, sci-fi, TV, movies, new, top rated, hidden gems, and a
// personalised "for you" source), so the feed does not run dry in practice.
//
// Query:  cursor  – value of `next` from the previous response (omit for first call)
//         seed    – any number; varies where a new feed starts (variety per visit)
//         src     – optional: stick to ONE source (action, comedy, tv, …)
//         genres  – optional: comma list of TMDB genre ids for the "for you" source
// ============================================================
'use strict';

module.exports = function mountReelsFeed(ctx) {
  const { app, tmdbFetch, buildClips, clipCached, mixedTitles, CLIP_SECTIONS, POP } = ctx;
  if (!app || !tmdbFetch || !buildClips || !clipCached || !mixedTitles || !CLIP_SECTIONS) {
    console.error('❌ reels-feed: missing dependencies from server.js — feed disabled');
    return;
  }

  const TV_GENRE_MAP = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
  const MAX_PAGE = 60;      // pages per source before wrapping (clients de-duplicate)
  const WANT = 12;          // clips per response

  // every titled source: the section sources from server.js + two extra ones
  const SOURCES = {};
  for (const [k, v] of Object.entries(CLIP_SECTIONS)) SOURCES[k] = { titles: v.titles };
  SOURCES.toprated = { titles: p => mixedTitles(p, '/movie/top_rated', {}, '/tv/top_rated', {}) };
  SOURCES.gems     = { titles: p => mixedTitles(p, '/discover/movie', { sort_by: 'vote_average.desc', 'vote_count.gte': 2500 }, '/discover/tv', { sort_by: 'vote_average.desc', 'vote_count.gte': 800 }) };

  // order used by the mixed "For You" feed
  const MIX = ['trending', 'action', 'comedy', 'foryou', 'emotional', 'shocking', 'mindblowing', 'tv', 'movies', 'foryou', 'recent', 'toprated', 'gems'];
  const VALID_KEYS = new Set([...Object.keys(SOURCES), 'foryou']);

  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  function dec(s) {
    try {
      const o = JSON.parse(Buffer.from(String(s), 'base64url').toString());
      const pages = {};
      for (const k of Object.keys(o.pages || {})) if (VALID_KEYS.has(k)) pages[k] = Math.max(0, Math.min(MAX_PAGE, parseInt(o.pages[k]) || 0));
      return { m: Math.max(0, parseInt(o.m) || 0) % MIX.length, pages };
    } catch (_) { return null; }
  }
  function startCursor(seed) {
    const pages = {};
    [...VALID_KEYS].forEach((k, i) => { pages[k] = Math.abs(seed * 31 + i * 17) % 12; });   // random start page per source
    return { m: Math.abs(seed) % MIX.length, pages };
  }

  async function titlesFor(key, page, genres) {
    if (key === 'foryou') {
      const tvIds = [...new Set(genres.map(g => TV_GENRE_MAP[g] || g))];
      return mixedTitles(page,
        '/discover/movie', { ...(POP || { sort_by: 'popularity.desc' }), with_genres: genres.join('|'), 'vote_count.gte': 300 },
        '/discover/tv',    { ...(POP || { sort_by: 'popularity.desc' }), with_genres: tvIds.join('|'),   'vote_count.gte': 100 });
    }
    return SOURCES[key].titles(page);
  }

  // avoid showing two clips of the same title back-to-back
  function spread(items) {
    const out = [], rest = items.slice();
    while (rest.length) {
      const last = out.length ? out[out.length - 1].tmdbId : null;
      let i = rest.findIndex(x => x.tmdbId !== last);
      if (i === -1) i = 0;
      out.push(rest.splice(i, 1)[0]);
    }
    return out;
  }

  app.get('/api/clips/feed', async (req, res) => {
    try {
      const only = req.query.src && VALID_KEYS.has(String(req.query.src)) ? String(req.query.src) : null;
      const genres = String(req.query.genres || '').split(',').map(x => parseInt(x)).filter(Boolean).slice(0, 3);
      const seed = parseInt(req.query.seed) || Math.floor(Math.random() * 1e6);
      const cur = (req.query.cursor && dec(req.query.cursor)) || startCursor(seed);

      const items = [], seen = new Set();
      let guard = 0;
      while (items.length < WANT && guard++ < 8) {
        let key = only;
        if (!key) {
          key = MIX[cur.m % MIX.length]; cur.m = (cur.m + 1) % MIX.length;
          if (key === 'foryou' && !genres.length) continue;          // not personalised yet → next source
        } else if (key === 'foryou' && !genres.length) {
          return res.status(400).json({ success: false, error: 'genres required for src=foryou' });
        }
        let page = (cur.pages[key] || 0) + 1;
        if (page > MAX_PAGE) page = 1;
        cur.pages[key] = page;

        let batch = [];
        try {
          batch = await clipCached(`feed:${key}:${page}:${key === 'foryou' ? genres.join('-') : ''}`, async () => {
            const titles = await titlesFor(key, page, genres);
            return buildClips((titles || []).slice(0, 20), { perTitle: 2, limit: 24 });
          }, 20 * 60 * 1000);
        } catch (err) {
          cur.pages[key] = 0;                                         // page out of range / TMDB hiccup → restart this source
          continue;
        }
        for (const c of batch || []) if (!seen.has(c.videoId)) { seen.add(c.videoId); items.push(c); }
      }

      res.json({ success: true, data: { items: spread(items), next: enc(cur), hasMore: true } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('🎞️  Reels feed ready: GET /api/clips/feed');
};
