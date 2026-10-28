// Latest player notes (Rotowire-style blurbs via ESPN's public athlete overview) for up to 12 players.
// GET /api/playernews?sport=nfl&p=<name>|<team>|<espnId>,...  -> { items: { "<name>|<team>": { espn, headline, story, published } } }
// When a player has no ESPN id in Sleeper's data, it's looked up by name (and team when it matches).
const LEAGUE = { nfl: ['football', 'nfl'], nba: ['basketball', 'nba'] };
const j = async url => { const r = await fetch(url, { headers: { 'accept': 'application/json' } }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };

async function findId(sport, name, team) {
  const [s, l] = LEAGUE[sport];
  const d = await j(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=5&type=player&sport=${s}&league=${l}`);
  const items = (d.items || []).filter(x => x.type === 'player');
  const onTeam = items.find(x => (x.teamRelationships || []).some(t => t.core && t.core.abbreviation === team));
  return (onTeam || items[0] || {}).id || null;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const sport = q.sport === 'nba' ? 'nba' : 'nfl';
  const list = String(q.p || '').split(',').filter(Boolean).slice(0, 12).map(x => { const [name, team, espn] = x.split('|'); return { key: `${name}|${team}`, name, team, espn }; });
  if (!list.length) return res.status(400).json({ error: 'pass p=name|team|espnId,...' });
  const [s, l] = LEAGUE[sport];
  const items = {};
  await Promise.all(list.map(async x => {
    try {
      const id = x.espn || await findId(sport, x.name, x.team);
      if (!id) return;
      const d = await j(`https://site.web.api.espn.com/apis/common/v3/sports/${s}/${l}/athletes/${id}/overview`);
      const r = d.rotowire || null;
      const n = (d.news || [])[0] || null;
      items[x.key] = { espn: String(id), headline: r ? r.headline || r.description : n ? n.headline : null, story: r ? r.story || null : n ? n.description || null : null, published: r ? r.published : n ? n.lastModified : null };
    } catch { /* one player failing shouldn't fail the batch */ }
  }));
  res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
  res.status(200).json({ items });
};
