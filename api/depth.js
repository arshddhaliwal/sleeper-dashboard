// Expected lineups for all 32 NFL teams from ESPN's formation depth charts (offense "3WR 1TE", defense "Base 4-3 D" /
// "Base 3-4 D"), including the offensive line, which Sleeper's depth charts don't order. Each slot lists players in
// ESPN's order with their injury flag; the browser links them to Sleeper players through the ESPN athlete id.
//
// GET /api/depth
//   -> { updated, teams: { "CAR": { off: { name: "3WR 1TE", slots: { qb: [{ espn, name, inj }], lt: [...] } },
//                                   def: { name: "Base 3-4 D", slots: { lde: [...], ... } } } } }

const ABBR = { WSH: 'WAS' };
const fetchJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} for ${u}`); return r.json(); };

module.exports = async (req, res) => {
  try {
    const list = await fetchJson('https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40');
    const teams = (((list.sports || [])[0] || {}).leagues || [])[0].teams || [];
    const out = {};
    await Promise.all(teams.map(async ({ team }) => {
      const abbr = ABBR[team.abbreviation] || team.abbreviation;
      try {
        const dc = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team.id}/depthcharts`);
        const t = { off: null, def: null };
        for (const f of dc.depthchart || []) {
          const name = f.name || '';
          if (/special/i.test(name)) continue;
          const slots = {};
          for (const [k, v] of Object.entries(f.positions || {})) {
            slots[k] = (v.athletes || []).slice(0, 4).map(a => ({ espn: String(a.id), name: a.displayName, inj: ((a.injuries || [])[0] || {}).status || '' }));
          }
          const side = /\bD\b|defense/i.test(name) || slots.lde || slots.lcb ? 'def' : 'off';
          if (!t[side]) t[side] = { name, slots };
        }
        out[abbr] = t;
      } catch (e) { out[abbr] = { error: String(e.message || e) }; }
    }));
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=7200');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ updated: Date.now(), teams: out }));
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
