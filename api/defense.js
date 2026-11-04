// Defense-vs-position aggregates. For every completed week this season, sums the raw stat lines of all
// opposing QBs / RBs / WRs / TEs / Ks that faced each NFL defense. The browser applies each league's own
// scoring to those sums (scoring is linear, so points(sum of stats) == sum of points), which is what
// makes the Start/Sit grades match the league's actual rules instead of a generic PPR table.
//
// GET /api/defense?season=2026&week=9
//   -> { season, weeks: [1..8], data: { "BUF": { "QB": { "1": { pass_yd, pass_td, ..., n }, "2": ... }, "RB": {...} } } }
//   A missing week for a team is its bye (or a game not yet played).

const POS = ['QB', 'RB', 'WR', 'TE', 'K'];
const FOLD = { FB: 'RB' };
// rates, ranks and snap counts are not additive; everything else (yards, TDs, receptions, bonuses, fantasy points) is
const SKIP = /^(tm_|opp_|pos_rank|off_snp|def_snp|st_snp|gp$|gs$|gms_active$|pass_rtg$|cmp_pct$|h[12]_|q[1-4]_)|(_lng|_pct|_ypa|_ypc|_ypr|_ypt|_avg)$/;

async function weekStats(season, week) {
  const q = POS.map(p => `position%5B%5D=${p}`).join('&');
  const r = await fetch(`https://api.sleeper.app/stats/nfl/${season}/${week}?season_type=regular&${q}&order_by=pts_ppr`);
  if (!r.ok) throw new Error(`Sleeper stats ${season}/${week} responded ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

module.exports = async (req, res) => {
  const season = String(req.query.season || new Date().getFullYear()).replace(/\D/g, '').slice(0, 4);
  const week = Math.max(1, Math.min(18, parseInt(req.query.week, 10) || 1));
  try {
    const weeks = []; for (let w = 1; w <= week; w++) weeks.push(w);
    const all = await Promise.all(weeks.map(w => weekStats(season, w).catch(() => [])));
    const data = {}; const have = [];
    all.forEach((rows, i) => {
      const w = weeks[i]; let any = false;
      for (const row of rows) {
        const def = row.opponent, team = row.team, st = row.stats;
        if (!def || !team || !st || !(st.gp || st.gms_active || st.off_snp || st.pts_ppr != null)) continue;
        const raw = (row.player && (row.player.fantasy_positions || [])[0]) || (row.player && row.player.position) || '';
        const pos = FOLD[raw] || raw;
        if (!POS.includes(pos)) continue;
        any = true;
        const slot = ((data[def] = data[def] || {})[pos] = data[def][pos] || {});
        const agg = (slot[w] = slot[w] || { n: 0 });
        agg.n++;
        for (const [k, v] of Object.entries(st)) {
          if (typeof v !== 'number' || !v || SKIP.test(k)) continue;
          agg[k] = Math.round(((agg[k] || 0) + v) * 100) / 100;
        }
      }
      if (any) have.push(w);
    });
    // games played this week are in flux until Tuesday; completed history can sit at the edge for longer
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=21600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ season, weeks: have, data }));
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
