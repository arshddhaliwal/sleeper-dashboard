// Market trade values from FantasyCalc (players + draft picks), keyed by Sleeper id.
// Query: dynasty=1|0, teams, ppr, qbs. Returns { players: { sleeperId: [value, trend30, tier, posRank] }, picks: { "2027 1st (Early)": value } }
module.exports = async (req, res) => {
  const q = req.query || {};
  const dynasty = q.dynasty === '0' ? 'false' : 'true';
  const teams = Math.min(32, Math.max(4, parseInt(q.teams, 10) || 12));
  const ppr = ['0', '0.5', '1'].includes(String(q.ppr)) ? String(q.ppr) : '0.5';
  const qbs = q.qbs === '2' ? '2' : '1';
  try {
    const r = await fetch(`https://api.fantasycalc.com/values/current?isDynasty=${dynasty}&numQbs=${qbs}&numTeams=${teams}&ppr=${ppr}`);
    if (!r.ok) throw new Error(`FantasyCalc responded ${r.status}`);
    const rows = await r.json();
    const players = {}, picks = {};
    for (const x of rows) {
      const p = x.player || {};
      if (p.position === 'PICK') { picks[p.name] = x.value; continue; }
      if (p.sleeperId) players[p.sleeperId] = [x.value, x.trend30Day || 0, x.maybeTier || null, x.positionRank || null];
    }
    res.setHeader('Cache-Control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({ players, picks, source: 'FantasyCalc' });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
