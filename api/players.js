// Slim proxy for Sleeper's ~15MB player database.
// Returns { id: [name, positions, team, age, years_exp, injury_status, body_part, news_updated, espn_id, practice] }.
module.exports = async (req, res) => {
  const sport = req.query && req.query.sport === 'nba' ? 'nba' : 'nfl';
  try {
    const r = await fetch(`https://api.sleeper.app/v1/players/${sport}`);
    if (!r.ok) throw new Error(`Sleeper responded ${r.status}`);
    const all = await r.json();
    const out = {};
    for (const [id, p] of Object.entries(all)) {
      if (!p) continue;
      const pos = (p.fantasy_positions && p.fantasy_positions.length ? p.fantasy_positions : (p.position ? [p.position] : []));
      if (!pos.length) continue;
      const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || id;
      out[id] = [name, pos.join('/'), p.team || '', p.age || null, p.years_exp == null ? null : p.years_exp,
        p.injury_status || '', p.injury_body_part || '', p.news_updated || 0, p.espn_id || null, p.practice_participation || ''];
    }
    // injury statuses change often; keep the edge copy fresh
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(out));
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
