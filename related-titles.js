// ============================================================
// YOUFLEX RELATED TITLES  —  GET /api/related/:type/:id
//
// Replaces TMDB's loose "similar" list with a strict, ranked one. Every title
// returned has a REASON, and loosely-related titles are filtered out:
//
//   1. Same franchise / collection       (sequels, prequels, spin-offs)   score 100
//   2. TMDB "recommendations"            (what fans of this title watch)  score  70
//   3. Same director                                                      score  60
//   4. Same themes (shared TMDB keywords, same type)                      score  50
//   5. TMDB "similar"  (only if it shares genres)                         score  30
//
// Non-franchise titles must share at least one genre with the source title (and
// the same language, or two genres), have a poster and a minimum vote count.
// ============================================================
'use strict';

module.exports = function mountRelated(ctx) {
  const { app, tmdbFetch, clipCached } = ctx;
  if (!app || !tmdbFetch || !clipCached) {
    console.error('❌ related-titles: missing dependencies from server.js — endpoint disabled');
    return;
  }
  const MAX_ITEMS = 18;
  const yearOf = x => parseInt(String((x && (x.release_date || x.first_air_date)) || '').slice(0, 4)) || null;

  async function build(type, id) {
    const src = await tmdbFetch(`/${type}/${id}`, { append_to_response: 'credits,keywords' });
    const srcId = Number(id);
    const srcGenres = new Set((src.genres || []).map(g => g.id));
    const srcLang = src.original_language;
    const srcYear = yearOf(src);
    const srcTitle = src.title || src.name || 'this title';
    const keywords = ((type === 'movie' ? src.keywords && src.keywords.keywords : src.keywords && src.keywords.results) || []).slice(0, 6);

    const cand = new Map();
    function add(item, base, reason, opts) {
      opts = opts || {};
      if (!item || item.id === srcId || !item.poster_path || item.adult) return;
      const gids = item.genre_ids || (item.genres || []).map(g => g.id) || [];
      const overlap = gids.filter(g => srcGenres.has(g)).length;
      const votes = item.vote_count == null ? 999 : item.vote_count;
      if (!opts.exempt) {
        if (overlap < 1) return;                                     // must share a genre
        if (votes < 30) return;                                      // drop obscure noise
        if (!opts.trusted && item.original_language !== srcLang && overlap < 2) return;   // loose match → needs 2 genres if language differs
      }
      let score = base + overlap * 8 + (item.original_language === srcLang ? 4 : 0) + (votes >= 200 ? 4 : 0);
      const y = yearOf(item);
      if (srcYear && y) score -= Math.min(6, Math.abs(y - srcYear) / 4);
      const prev = cand.get(item.id);
      if (!prev || score > prev.score) cand.set(item.id, { item, score, reason });
    }

    const jobs = [];

    // 1. franchise (movies)
    const colId = src.belongs_to_collection && src.belongs_to_collection.id;
    if (type === 'movie' && colId) jobs.push(tmdbFetch(`/collection/${colId}`).then(c => (c.parts || []).forEach(p => add({ ...p, media_type: 'movie' }, 100, 'Same franchise', { exempt: true }))).catch(() => {}));

    // 2. recommendations
    jobs.push(tmdbFetch(`/${type}/${id}/recommendations`, { page: 1 }).then(r => (r.results || []).forEach(x => add(x, 70, `Fans of ${srcTitle} also watch`, { trusted: true }))).catch(() => {}));

    // 3. same director (movies)
    if (type === 'movie') {
      const dir = ((src.credits && src.credits.crew) || []).find(c => c.job === 'Director');
      if (dir) jobs.push(tmdbFetch(`/person/${dir.id}/movie_credits`).then(c => (c.crew || []).filter(x => x.job === 'Director').forEach(x => add(x, 60, `Directed by ${dir.name}`, { trusted: true }))).catch(() => {}));
    }

    // 4. same themes (shared keywords)
    if (keywords.length) {
      const ids = keywords.slice(0, 3).map(k => k.id).join('|');
      jobs.push(tmdbFetch(`/discover/${type}`, { with_keywords: ids, sort_by: 'popularity.desc', 'vote_count.gte': 80 })
        .then(r => (r.results || []).forEach(x => add(x, 50, `Similar theme: ${keywords[0].name}`))).catch(() => {}));
    }

    // 5. TMDB similar (weakest signal, filtered by genre)
    jobs.push(tmdbFetch(`/${type}/${id}/similar`, { page: 1 }).then(r => (r.results || []).forEach(x => add(x, 30, 'Similar genre & style'))).catch(() => {}));

    await Promise.all(jobs);

    const items = [...cand.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_ITEMS)
      .map(({ item, reason, score }) => ({
        id: item.id, media_type: type,
        title: item.title, name: item.name,
        poster_path: item.poster_path, backdrop_path: item.backdrop_path,
        vote_average: item.vote_average || 0,
        release_date: item.release_date, first_air_date: item.first_air_date,
        reason, score: Math.round(score),
      }));
    return { items, source: { id: srcId, type, title: srcTitle } };
  }

  app.get('/api/related/:type/:id', async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!['movie', 'tv'].includes(type)) return res.status(400).json({ success: false, error: 'type must be movie or tv' });
      if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
      const data = await clipCached(`related:${type}:${id}`, () => build(type, id), 30 * 60 * 1000);
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('🔗 Related titles ready: GET /api/related/:type/:id');
};
