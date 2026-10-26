// Latest ESPN headlines for a sport, trimmed to what the dashboard needs.
module.exports = async (req, res) => {
  const sport = req.query && req.query.sport === 'nba' ? 'basketball/nba' : 'football/nfl';
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/news?limit=100`);
    if (!r.ok) throw new Error(`ESPN responded ${r.status}`);
    const d = await r.json();
    const items = (d.articles || []).map(a => ({
      h: a.headline, d: a.description || '', t: a.published,
      url: a.links && a.links.web && a.links.web.href,
      ath: (a.categories || []).filter(c => c.type === 'athlete' && (c.athleteId || (c.athlete && c.athlete.id))).map(c => String(c.athleteId || c.athlete.id))
    }));
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    res.status(200).json({ items });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
