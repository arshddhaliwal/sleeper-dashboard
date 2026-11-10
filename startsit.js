'use strict';
/* Start/Sit — the lineup agent.
   Takes each player's projection and adjusts it for the things a projection can't see: how the opposing defense has
   actually done against his position in THIS league's scoring, the forecast at kickoff (wind kills passing games),
   the betting line (implied team total and game script), his own injury tag, and injured starters on the defense
   he faces. Everything is shown with its reasons so a call is never a black box. NFL only. */

const SS_POS = ['QB', 'RB', 'WR', 'TE', 'K'];
const SS_GRADE = ['A', 'B', 'C', 'D', 'F'];
const DEF_POS = new Set(['DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S', 'EDGE', 'NT', 'ILB', 'OLB', 'FS', 'SS']);
const PASS_POS = new Set(['QB', 'WR', 'TE']);
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function ensureStartSit(L) {
  if (L.sport !== 'nfl') return null;
  const key = `${L.league.league_id}|${L.league.season}|${L.curWeek}`;
  if (S.ss && S.ss.key === key && S.ss.model) return S.ss.model;
  if (S.ss && S.ss.key === key && S.ss.promise) return S.ss.promise;
  const promise = (async () => {
    const [def, games, depth] = await Promise.all([
      jc(`/api/defense?season=${L.league.season}&week=${L.curWeek}`, { weeks: [], data: {} }),
      jc(`/api/games?season=${L.league.season}&week=${L.curWeek}`, { games: [] }),
      jc('/api/depth', { teams: {} })
    ]);
    const model = buildStartSit(L, def, games, depth);
    S.ss = { key, model };
    return model;
  })();
  S.ss = { key, promise };
  return promise;
}

/* ---------- defense vs position, in this league's scoring ---------- */
function defenseModel(L, def) {
  const sc = L.scoring;
  const pts = s => { let t = 0; for (const k in sc) { const v = s[k]; if (v) t += v * sc[k]; } return t; };
  const weeks = (def.weeks || []).filter(w => w < L.curWeek); // the current week is in flux until Tuesday
  const teams = Object.keys(def.data || {}).sort();
  const D = {}; // D[team][pos] = { weekly: {w: pts}, g, avg, recent, ratio, ratioRecent, blend, grade, rank }
  for (const t of teams) {
    D[t] = {};
    for (const pos of SS_POS) {
      const wk = (def.data[t] || {})[pos] || {};
      const weekly = {}; let sum = 0, g = 0;
      for (const w of weeks) if (wk[w]) { weekly[w] = Math.round(pts(wk[w]) * 10) / 10; sum += weekly[w]; g++; }
      const played = Object.keys(weekly).map(Number).sort((a, b) => a - b);
      const last3 = played.slice(-3);
      const recent = last3.length ? last3.reduce((a, w) => a + weekly[w], 0) / last3.length : null;
      D[t][pos] = { weekly, g, avg: g ? sum / g : null, recent };
    }
  }
  const lg = {}; // league averages per position
  for (const pos of SS_POS) {
    const vals = teams.map(t => D[t][pos].avg).filter(v => v != null);
    lg[pos] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const ranked = teams.filter(t => D[t][pos].avg != null).map(t => {
      const d = D[t][pos];
      d.ratio = lg[pos] ? d.avg / lg[pos] : 1;
      d.ratioRecent = lg[pos] && d.recent != null ? d.recent / lg[pos] : d.ratio;
      d.blend = 0.6 * d.ratio + 0.4 * d.ratioRecent; // >1 = gives up more than average = good matchup for the offense
      return t;
    }).sort((a, b) => D[b][pos].blend - D[a][pos].blend);
    ranked.forEach((t, i) => {
      const d = D[t][pos]; d.rank = i + 1;
      d.grade = i < 5 ? 'A' : i < 12 ? 'B' : i < 20 ? 'C' : i < 27 ? 'D' : 'F';
    });
  }
  return { D, lg, weeks, teams };
}

/* ---------- injured defensive starters by NFL team ---------- */
function defenseInjuries(L) {
  const out = {};
  for (const id of L.pids) {
    const p = L.player(id);
    if (!p.team || !p.inj || !p.positions.some(x => DEF_POS.has(x))) continue;
    if (p.depth !== 1) continue; // depth-chart starters only (each CB/S spot has its own chart)
    const sev = OUT.has(p.inj) ? 1 : p.inj === 'Doubtful' ? 0.8 : p.inj === 'Questionable' ? 0.4 : 0;
    if (!sev) continue;
    const grp = /CB|DB|NB|^S$|FS|SS/.test(p.depthPos || p.pos) ? 'secondary' : 'front';
    (out[p.team] = out[p.team] || []).push({ name: p.name, pos: p.depthPos || p.pos, inj: p.inj, sev, grp });
  }
  return out;
}

/* ---------- game environment ---------- */
function gameEnv(games) {
  const byTeam = {};
  for (const g of games.games || []) {
    const k = new Date(g.kickoff);
    const when = isNaN(k) ? '' : `${DAY[k.getDay()]} ${k.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    const env = { ...g, when, flags: [] };
    const wx = g.wx;
    if (g.indoor) env.flags.push({ k: 'dome', t: 'Indoors', sev: 0 });
    else if (wx) {
      const w = Math.max(wx.wind || 0, (wx.gust || 0) - 8);
      env.windEff = w;
      if (w >= 20) env.flags.push({ k: 'wind', t: `Wind ${wx.wind} mph, gusts ${wx.gust}`, sev: 2 });
      else if (w >= 15) env.flags.push({ k: 'wind', t: `Breezy · ${wx.wind} mph, gusts ${wx.gust}`, sev: 1 });
      const snow = wx.code != null && ((wx.code >= 71 && wx.code <= 77) || wx.code === 85 || wx.code === 86);
      env.snow = snow; env.rain = !snow && (wx.rainPct || 0) >= 60 && (wx.precip || 0) >= 0.1;
      if (snow) env.flags.push({ k: 'snow', t: `Snow · ${wx.rainPct}%`, sev: 2 });
      else if (env.rain) env.flags.push({ k: 'rain', t: `Rain ${wx.rainPct}% · ${wx.precip}"`, sev: (wx.rainPct >= 80 && wx.precip >= 0.25) ? 2 : 1 });
      if (wx.temp != null && wx.temp <= 20) env.flags.push({ k: 'cold', t: `${wx.temp}°F`, sev: 1 });
    }
    byTeam[g.home] = env; byTeam[g.away] = env;
  }
  const totals = (games.games || []).map(g => g.odds).filter(o => o && o.favTotal != null).flatMap(o => [o.favTotal, o.dogTotal]);
  const avgTotal = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 23;
  return { byTeam, avgTotal, games: games.games || [] };
}

/* ---------- one player's adjusted projection, with reasons ---------- */
function adjustPlayer(L, M, p) {
  const r = { p, factors: [], base: 0, adj: 0, grade: null, opp: null, home: null, env: null, bye: false, out: false };
  const pos = SS_POS.includes(p.pos) ? p.pos : null;
  r.base = p.proj > 0 ? (p.gp >= 3 ? 0.65 * p.proj + 0.35 * p.ppg : p.proj) : (p.bye ? 0 : p.ppg * 0.9);
  if (!p.team || p.bye) { r.bye = !!p.bye; r.adj = 0; return r; }
  const g = p.game; const env = M.env.byTeam[p.team];
  r.env = env || null;
  r.home = g ? g.home === p.team : env ? env.home === p.team : null;
  r.opp = g ? (g.home === p.team ? g.away : g.home) : env ? (env.home === p.team ? env.away : env.home) : null;
  let m = 1;
  const push = (k, label, mult, sev = 0) => { if (Math.abs(mult - 1) >= 0.005) { r.factors.push({ k, label, mult, sev }); m *= mult; } };
  // 1. matchup: how this defense has done against his position in this league's scoring
  if (pos && r.opp && M.def.D[r.opp] && M.def.D[r.opp][pos] && M.def.D[r.opp][pos].avg != null) {
    const d = M.def.D[r.opp][pos]; r.grade = d.grade; r.defRow = d;
    const k = 0.5 * Math.min(1, d.g / 8); // trust the sample more as the season goes on
    push('matchup', `${r.opp} vs ${pos}: grade ${d.grade} (#${d.rank}, ${f1(d.avg)} allowed/g vs ${f1(M.def.lg[pos])} avg)`, 1 + (d.blend - 1) * k, d.grade === 'A' || d.grade === 'B' ? -1 : d.grade === 'F' || d.grade === 'D' ? 1 : 0);
  }
  // 2. weather at kickoff
  if (env && !env.indoor && env.wx) {
    const w = env.windEff || 0;
    if (pos === 'K') push('wind', `Wind ${env.wx.wind} mph (gusts ${env.wx.gust})`, w >= 20 ? 0.8 : w >= 15 ? 0.9 : 1, w >= 15 ? 2 : 0);
    else if (PASS_POS.has(pos)) push('wind', `Wind ${env.wx.wind} mph (gusts ${env.wx.gust})`, w >= 25 ? 0.82 : w >= 20 ? 0.88 : w >= 15 ? 0.95 : 1, w >= 20 ? 2 : w >= 15 ? 1 : 0);
    else if (pos === 'RB') push('wind', `Wind ${env.wx.wind} mph → more rushing`, w >= 20 ? 1.03 : 1, 0);
    if (env.snow) push('snow', `Snow in the forecast (${env.wx.rainPct}%)`, PASS_POS.has(pos) ? 0.9 : pos === 'K' ? 0.9 : 1.02, 2);
    else if (env.rain) push('rain', `Rain likely (${env.wx.rainPct}%, ${env.wx.precip}")`, PASS_POS.has(pos) || pos === 'K' ? 0.95 : 1.01, 1);
    if (env.wx.temp != null && env.wx.temp <= 20) push('cold', `${env.wx.temp}°F at kickoff`, PASS_POS.has(pos) || pos === 'K' ? 0.97 : 1, 1);
  }
  // 3. betting line: implied team total and game script
  if (env && env.odds && env.odds.favTotal != null) {
    const o = env.odds; const mine = o.fav === p.team ? o.favTotal : o.fav ? o.dogTotal : o.ou / 2;
    const f = Math.max(0.88, Math.min(1.12, 1 + (mine - M.env.avgTotal) / M.env.avgTotal * 0.5));
    push('vegas', `Implied ${f1(mine)} team pts (O/U ${o.ou}${o.fav ? `, ${o.fav} −${o.spread}` : ''})`, f, f >= 1.04 ? -1 : f <= 0.96 ? 1 : 0);
    if (o.spread >= 7 && o.fav) {
      const favored = o.fav === p.team;
      if (pos === 'RB') push('script', favored ? `Big favorite (−${o.spread}): run-heavy script` : `Big underdog (+${o.spread}): fewer carries late`, favored ? 1.04 : 0.95, favored ? -1 : 1);
      else if (PASS_POS.has(pos)) push('script', favored ? `Big favorite (−${o.spread}): may sit on the lead` : `Big underdog (+${o.spread}): garbage-time volume`, favored ? 0.97 : 1.03, 0);
    }
  }
  // 4. his own injury tag
  if (p.out) { r.out = true; push('inj', `${p.inj}${p.body ? ' · ' + p.body : ''}`, 0, 3); }
  else if (p.inj === 'Doubtful') push('inj', `Doubtful${p.body ? ' · ' + p.body : ''}`, 0.5, 2);
  else if (p.inj === 'Questionable') push('inj', `Questionable${p.body ? ' · ' + p.body : ''}${p.practice ? ' · ' + p.practice : ''}`, 0.92, 1);
  // 5. injured starters on the defense he faces
  const inj = r.opp && M.defInj[r.opp] || [];
  if (inj.length && pos) {
    const rel = inj.filter(x => PASS_POS.has(pos) ? x.grp === 'secondary' || (pos === 'QB' && x.grp === 'front') : pos === 'RB' ? x.grp === 'front' : false);
    if (rel.length) {
      const boost = Math.min(0.1, rel.reduce((a, x) => a + 0.03 * x.sev * (pos === 'QB' && x.grp === 'front' ? 0.5 : 1), 0));
      push('definj', `${r.opp} D missing ${rel.map(x => `${x.name} (${x.pos}, ${x.inj === 'Questionable' ? 'Q' : x.inj === 'Doubtful' ? 'D' : x.inj})`).join(', ')}`, 1 + boost, -1);
      r.defInj = rel;
    }
  }
  // 6. home field
  if (r.home != null && pos) push('home', r.home ? 'Home' : 'Away', r.home ? 1.015 : 0.985, 0);
  r.mult = m;
  r.adj = Math.max(0, r.base * m);
  // floor / ceiling from how spiky his weeks have been
  const ws = Object.values(p.weeks).filter(v => v != null);
  if (ws.length >= 3 && p.ppg > 0) {
    const mean = ws.reduce((a, b) => a + b, 0) / ws.length; const sd = Math.sqrt(ws.reduce((a, b) => a + (b - mean) ** 2, 0) / ws.length);
    const scale = r.adj / Math.max(p.ppg, 1);
    r.floor = Math.max(0, r.adj - 0.8 * sd * scale); r.ceil = r.adj + 1.0 * sd * scale; r.vol = sd / Math.max(mean, 1);
  } else { r.floor = r.adj * 0.6; r.ceil = r.adj * 1.4; r.vol = null; }
  return r;
}

/* ---------- lineup: current vs recommended by adjusted projection ---------- */
function bestLineup(L, rows) {
  const order = L.slots.map((s, i) => ({ s, i, n: eligible(s).length })).sort((a, b) => a.n - b.n);
  const used = new Set(); const lineup = [];
  for (const { s, i } of order) {
    const el = eligible(s); let best = null;
    for (const r of rows) if (!used.has(r.p.id) && !r.out && !r.bye && r.p.positions.some(x => el.includes(x)) && (!best || r.adj > best.adj)) best = r;
    if (best) used.add(best.p.id);
    lineup[i] = { slot: s, r: best };
  }
  return { lineup, used, total: lineup.reduce((a, x) => a + (x.r ? x.r.adj : 0), 0) };
}

/* ---------- depth charts: team -> slot -> players in order ---------- */
function depthCharts(L) {
  const out = {};
  for (const id of L.pids) {
    const p = L.player(id);
    if (!p.team || !p.depthPos || !p.depth) continue;
    ((out[p.team] = out[p.team] || {})[p.depthPos] = out[p.team][p.depthPos] || []).push(p);
  }
  for (const t of Object.values(out)) for (const arr of Object.values(t)) arr.sort((a, b) => a.depth - b.depth);
  return out;
}

function buildStartSit(L, def, games, depth) {
  const M = { def: defenseModel(L, def), env: gameEnv(games), defInj: defenseInjuries(L), depth: depthCharts(L), espnDepth: (depth && depth.teams) || {} };
  M.byEspn = {}; M.byName = {}; // ESPN athlete id first; fall back to name + team (some Sleeper records have no espn_id)
  for (const id of L.pids) { const p = L.player(id); if (p.espn) M.byEspn[p.espn] = id; if (p.team && p.pos !== 'DEF') M.byName[norm(p.name) + '|' + p.team] = id; }
  M.rows = {}; const row = id => M.rows[id] || (M.rows[id] = adjustPlayer(L, M, L.player(id)));
  M.row = row;
  if (L.me) {
    const active = activePids(L, L.me).map(row);
    M.mine = active;
    const best = bestLineup(L, active);
    const curIds = L.me.slotsRaw || [];
    const curSet = new Set(curIds.filter(id => id && id !== '0'));
    // true swaps = bench players the model starts, paired with the starters it benches (a starter who only moves
    // to another slot is a shuffle, not a swap)
    const ins = [...best.used].filter(id => !curSet.has(id)).map(row).sort((a, b) => b.adj - a.adj);
    const outs = [...curSet].filter(id => !best.used.has(id)).map(row).sort((a, b) => b.adj - a.adj);
    const swapFor = {}; // in-player id -> { out, gain }: pair each promoted player with a benched one at his position if possible
    const left = [...outs];
    ins.forEach(r => { let i = left.findIndex(o => o.p.pos === r.p.pos); if (i < 0) i = left.length - 1; const o = i >= 0 ? left.splice(i, 1)[0] : null; swapFor[r.p.id] = { out: o, gain: r.adj - (o ? o.adj : 0) }; });
    M.lineup = L.slots.map((slot, i) => {
      const curId = curIds[i] && curIds[i] !== '0' ? curIds[i] : null;
      const cur = curId ? row(curId) : null;
      const rec = best.lineup[i] && best.lineup[i].r || null;
      const el = eligible(slot);
      const alts = active.filter(r => r.p.positions.some(x => el.includes(x)) && (!cur || r.p.id !== cur.p.id)).sort((a, b) => b.adj - a.adj);
      const sw = rec && swapFor[rec.p.id];
      const kind = !rec ? 'none' : cur && rec.p.id === cur.p.id ? 'keep' : sw ? 'swap' : 'shuffle';
      return { slot, i, cur, rec, alts: alts.slice(0, 3), kind, change: kind === 'swap' && sw.gain > 0.3, gain: sw ? sw.gain : 0, out: sw ? sw.out : null };
    });
    M.curTotal = M.lineup.reduce((a, x) => a + (x.cur ? x.cur.adj : 0), 0);
    M.bestTotal = best.total;
    M.swaps = M.lineup.filter(x => x.change).map(x => ({ slot: x.slot, rec: x.rec, cur: x.out, gain: x.gain })).sort((a, b) => b.gain - a.gain);
    M.bestUsed = best.used;
    M.swapOut = {}; M.swaps.forEach(sw => { if (sw.cur) M.swapOut[sw.cur.p.id] = sw; }); // benched player -> who replaces him
    // close calls: top two options for a slot within 1.5 adjusted points
    M.coinflips = M.lineup.filter(x => x.rec && x.alts.length && x.alts.find(a => a.p.id !== x.rec.p.id && Math.abs(a.adj - x.rec.adj) <= 1.5 && a.adj > 3))
      .map(x => ({ slot: x.slot, a: x.rec, b: x.alts.find(a => a.p.id !== x.rec.p.id) }));
  }
  return M;
}

/* ---------------- views ---------------- */
const gradePill = (g, title = '') => g ? `<span class="gr g${g}" title="${esc(title)}">${g}</span>` : '<span class="gr gN" title="No data">–</span>';
const pct = m => `${m >= 1 ? '+' : ''}${Math.round((m - 1) * 100)}%`;
function factorChips(r, { max = 6 } = {}) {
  return r.factors.slice(0, max).map(f => `<span class="fct ${f.mult > 1 ? 'up' : f.mult < 1 ? 'dn' : ''} s${f.sev}" title="${esc(f.label)}">${esc(f.k === 'matchup' ? `${r.opp} ${r.grade}` : f.k === 'wind' ? `💨 ${r.env.wx.wind}` : f.k === 'rain' ? `🌧 ${r.env.wx.rainPct}%` : f.k === 'snow' ? '❄️' : f.k === 'cold' ? `🥶 ${r.env.wx.temp}°` : f.k === 'vegas' ? `O/U ${r.env.odds.ou}` : f.k === 'script' ? (f.mult > 1 ? 'script +' : 'script −') : f.k === 'inj' ? (r.p.inj === 'Questionable' ? 'Q' : r.p.inj === 'Doubtful' ? 'D' : r.p.inj) : f.k === 'definj' ? `${r.opp} D hurt` : f.k === 'home' ? (r.home ? 'home' : 'away') : f.k)} <b>${pct(f.mult)}</b></span>`).join('');
}
function rangeBar(r, maxv) {
  if (!r || !(r.adj > 0)) return '';
  const W = 120, x = v => Math.max(0, Math.min(W, v / maxv * W));
  return `<svg class="rng" width="${W}" height="14" viewBox="0 0 ${W} 14" aria-hidden="true"><rect x="0" y="6" width="${W}" height="2" rx="1" fill="var(--line)"/><rect x="${x(r.floor).toFixed(1)}" y="4" width="${Math.max(2, x(r.ceil) - x(r.floor)).toFixed(1)}" height="6" rx="3" fill="color-mix(in srgb,var(--accent) 35%,transparent)"/><rect x="${(x(r.base) - 1).toFixed(1)}" y="1" width="2" height="12" fill="var(--dim)"/><circle cx="${x(r.adj).toFixed(1)}" cy="7" r="4" fill="var(--accent)"/></svg>`;
}
function playerLine(L, r, { showRange = true, maxv = 30 } = {}) {
  if (!r) return '<div class="mute">empty</div>';
  const p = r.p;
  const sub = r.bye ? '<span class="bad">BYE</span>' : r.opp ? `${r.home ? 'vs' : '@'} ${esc(r.opp)}${r.env && r.env.when ? ' · ' + esc(r.env.when) : ''}` : esc(p.team || 'FA');
  return `<div class="ssp">${headshot(L, p)}<div class="ssb"><div class="nm"><span class="nmlink" data-hist="${esc(p.id)}">${esc(p.name)}</span>${injTag(p)} <span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></div>
    <div class="sub">${sub}</div><div class="fcts">${factorChips(r)}</div></div>
    <div class="ssn"><div class="adj">${f1(r.adj)}</div><div class="sub" title="Sleeper projection blended with season pace">base ${f1(r.base)}</div>${showRange ? rangeBar(r, maxv) : ''}</div></div>`;
}

function vStartSit(L) {
  if (L.sport !== 'nfl') return `${leagueMeta(L)}<div class="card">Start/Sit is NFL only — it needs defenses, weather and betting lines.</div>`;
  const M = S.ss && S.ss.key === `${L.league.league_id}|${L.league.season}|${L.curWeek}` && S.ss.model;
  if (!M) { ensureStartSit(L).then(() => S.tab === 'startsit' && render()).catch(e => setMain(`<div class="err">${esc(e.message)}</div>`)); return `${leagueMeta(L)}<div class="loading">Grading defenses, pulling kickoff forecasts and betting lines…</div>`; }
  const view = S.ui.ssview || 'field';
  const seg = `<div class="controls"><div class="seg">${[['lineup', 'My lineup'], ['field', 'Field'], ['games', 'Game environment'], ['defense', 'Defense grades']].map(([k, l]) => `<button data-ssview="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${weekNav(L)}<span class="sub">grades use ${M.def.weeks.length} week${M.def.weeks.length === 1 ? '' : 's'} of games in this league's scoring</span></div>`;
  if (!M.mine) return `${leagueMeta(L)}${seg}${view === 'games' ? ssGames(L, M) : view === 'defense' ? ssDefense(L, M) : view === 'field' ? ssField(L, M) : '<div class="card">You don\'t have a team in this league.</div>'}`;
  const body = view === 'games' ? ssGames(L, M) : view === 'defense' ? ssDefense(L, M) : view === 'field' ? ssField(L, M) : ssLineup(L, M);
  return `${leagueMeta(L)}${seg}${body}`;
}

function ssLineup(L, M) {
  if (!L.me) return '<div class="card">You don\'t have a team in this league.</div>';
  const maxv = Math.max(10, ...M.mine.map(r => r.ceil || 0));
  const kp = `<div class="kpis">
    <div class="kpi"><div class="l">Current lineup</div><div class="v">${f1(M.curTotal)}</div><div class="s">adjusted projection</div></div>
    <div class="kpi"><div class="l">Best lineup</div><div class="v">${f1(M.bestTotal)}</div><div class="s">${M.bestTotal - M.curTotal > 0.3 ? `<span class="good">+${f1(M.bestTotal - M.curTotal)} available</span>` : 'you\'re already optimal'}</div></div>
    <div class="kpi"><div class="l">Swaps</div><div class="v">${M.swaps.length}</div><div class="s">${M.swaps.length ? 'worth making' : 'none needed'}</div></div>
    <div class="kpi"><div class="l">Coin flips</div><div class="v">${M.coinflips.length}</div><div class="s">within 1.5 pts</div></div></div>`;
  const swaps = M.swaps.length ? `<div class="card ssw"><h2>Recommended moves</h2>${M.swaps.map(x => `<div class="sugg"><div><b>${esc(x.slot)}</b>: start <b>${esc(x.rec.p.name)}</b>${x.cur ? ` over ${esc(x.cur.p.name)}` : ' (slot is empty)'}<div class="sub">${esc(why(x.rec, x.cur))}</div></div><div class="gain good">+${f1(x.gain)}</div></div>`).join('')}</div>` : '';
  const flips = M.coinflips.length ? `<div class="card"><h2>Coin flips</h2><div class="hint">Two options within 1.5 points. The lean is shown first — if one plays later in the day, start the early one and keep the late one as your pivot.</div>${M.coinflips.map(c => `<div class="sugg"><div><b>${esc(c.slot)}</b>: lean <b>${esc(c.a.p.name)}</b> (${f1(c.a.adj)}) over ${esc(c.b.p.name)} (${f1(c.b.adj)})<div class="sub">${esc(why(c.a, c.b))}</div></div></div>`).join('')}</div>` : '';
  const rows = M.lineup.map(x => `<div class="slotrow ${x.kind === 'swap' ? 'chg' : ''}">
      <div class="slotlab"><span class="pos ${POSCLS(x.slot)}">${esc(x.slot.replace('SUPER_FLEX', 'SFLX').replace('WRRB_FLEX', 'W/R').replace('REC_FLEX', 'W/T'))}</span></div>
      <div class="slotcur">${x.cur ? playerLine(L, x.cur, { maxv }) : '<div class="mute" style="padding:8px 0">Empty slot</div>'}</div>
      <div class="slotalt">${x.kind === 'swap' || x.kind === 'shuffle' ? `<div class="sub" style="margin-bottom:4px">Model's pick${x.kind === 'swap' ? ` <b class="good">from the bench</b>` : ` <span class="mute">(moves over from ${esc(x.rec.p.pos === 'QB' ? 'QB' : 'another slot')})</span>`}</div>${playerLine(L, x.rec, { maxv })}` : x.alts[0] ? `<div class="sub" style="margin-bottom:4px">Next best</div>${playerLine(L, x.alts[0], { maxv })}` : ''}</div>
    </div>`).join('');
  const bench = M.mine.filter(r => !L.me.starters.includes(r.p.id)).sort((a, b) => b.adj - a.adj);
  const benchT = `<div class="card" style="margin-top:16px"><h2>Everyone else</h2><div class="hint">Bench, ranked by adjusted projection. Hover a chip to see the reason behind it.</div>${bench.map(r => playerLine(L, r, { maxv })).join('') || '<div class="mute">No bench.</div>'}</div>`;
  return `${kp}${swaps}${flips}<div class="card"><h2>Slot by slot</h2><div class="hint">Left: who you have in. Right: who the model would start there (highlighted when he's coming off your bench), or the next-best option. Green dot = adjusted projection, grey tick = base, band = floor–ceiling.</div>
    <div class="legend"><span><i class="gr gA">A</i> easiest defense for that position</span><span><i class="gr gF">F</i> toughest</span><span>💨 wind · 🌧 rain · O/U = total · Q/D = his tag</span></div>${rows}</div>${benchT}`;
}
function why(a, b) {
  const top = r => r.factors.filter(f => f.k !== 'home').sort((x, y) => Math.abs(y.mult - 1) - Math.abs(x.mult - 1)).slice(0, 2).map(f => f.label);
  const ta = top(a); const tb = b ? top(b) : [];
  const parts = [];
  if (ta.length) parts.push(`${a.p.name.split(' ').pop()}: ${ta.join('; ')}`);
  if (b && tb.length) parts.push(`${b.p.name.split(' ').pop()}: ${tb.join('; ')}`);
  if (!parts.length) parts.push(`${a.p.name.split(' ').pop()} projects higher (${f1(a.adj)} vs ${b ? f1(b.adj) : '0'}).`);
  return parts.join(' · ');
}

function ssGames(L, M) {
  const mine = new Set((L.me ? L.me.starters : []).map(id => L.player(id).team).filter(Boolean));
  const games = [...M.env.games].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  if (!games.length) return '<div class="card">No game data for this week yet.</div>';
  const card = g => {
    const env = M.env.byTeam[g.home]; const wx = g.wx; const o = g.odds;
    const inj = t => (M.defInj[t] || []).filter(x => x.sev >= 0.8);
    const team = (t, isHome) => `<div class="gt ${mine.has(t) ? 'mine' : ''}"><img class="hs" src="https://sleepercdn.com/images/team_logos/nfl/${esc(t.toLowerCase())}.png" alt="" onerror="this.style.visibility='hidden'"><b>${esc(t)}</b>${o && o.favTotal != null ? `<span class="sub">${f1(o.fav === t ? o.favTotal : o.fav ? o.dogTotal : o.ou / 2)} implied</span>` : ''}${inj(t).length ? `<span class="sub bad" title="${esc(inj(t).map(x => `${x.name} (${x.pos}, ${x.inj})`).join(', '))}">${inj(t).length} D starter${inj(t).length > 1 ? 's' : ''} out</span>` : ''}</div>`;
    const wxHtml = g.indoor ? '<span class="wx">🏟 Indoors</span>' : wx ? `<span class="wx ${env.flags.some(f => f.sev === 2) ? 'bad' : env.flags.some(f => f.sev === 1) ? 'warn' : ''}">${wx.temp != null ? wx.temp + '°' : ''} ${esc(wx.label || '')}${wx.wind != null ? ` · 💨 ${wx.wind}${wx.gust > wx.wind ? `–${wx.gust}` : ''} mph` : ''}${wx.rainPct ? ` · 🌧 ${wx.rainPct}%` : ''}</span>` : '<span class="wx mute">No forecast yet</span>';
    return `<div class="card gcard ${mine.has(g.home) || mine.has(g.away) ? 'has' : ''}"><div class="gtop"><span class="sub">${esc(env.when)}${g.city ? ' · ' + esc(g.city) : ''}</span>${o ? `<span class="sub">${esc(o.details || '')}${o.ou ? ' · O/U ' + o.ou : ''}</span>` : ''}</div>
      <div class="gteams">${team(g.away)}<span class="vs">@</span>${team(g.home)}</div>
      <div class="gwx">${wxHtml}${env.flags.filter(f => f.k !== 'dome').map(f => `<span class="fct s${f.sev} dn">${esc(f.t)}</span>`).join('')}</div></div>`;
  };
  return `<div class="hint">Forecast is for the 3 hours from kickoff at the stadium (Open-Meteo). Lines from ESPN/DraftKings. Highlighted games include one of your starters. Wind is the number that matters: 15+ mph hurts passing, 20+ is a real problem.</div><div class="grid g3">${games.map(card).join('')}</div>`;
}

function ssDefense(L, M) {
  const D = M.def.D; const teams = M.def.teams;
  const sortPos = S.ui.sspos || 'QB'; const recent = S.ui.ssrecent === '1';
  const val = (t, pos) => { const d = D[t][pos]; return d.avg == null ? null : recent ? d.recent : d.avg; };
  const ranked = [...teams].sort((a, b) => (val(b, sortPos) ?? -1) - (val(a, sortPos) ?? -1));
  const myOpp = {}; if (L.me) M.mine.forEach(r => { if (r.opp && SS_POS.includes(r.p.pos)) (myOpp[r.opp] = myOpp[r.opp] || []).push(r); });
  const cell = (t, pos) => {
    const d = D[t][pos]; if (d.avg == null) return '<td class="n mute">–</td>';
    const v = recent ? d.recent : d.avg; const ratio = v / M.def.lg[pos];
    const mine = (myOpp[t] || []).filter(r => r.p.pos === pos);
    const title = `${t} vs ${pos}: ${f1(v)} pts/g allowed${recent ? ' (last 3)' : ''} · league avg ${f1(M.def.lg[pos])} · #${d.rank} easiest · weeks: ${Object.entries(d.weekly).map(([w, x]) => `W${w} ${f1(x)}`).join(', ')}${mine.length ? ' · your ' + mine.map(r => r.p.name).join(', ') + ' face them' : ''}`;
    return `<td class="n hm" data-hm="${esc(t)}|${pos}" style="--r:${Math.max(0, Math.min(2, ratio)).toFixed(2)}" title="${esc(title)}"><span class="gr g${d.grade} sm">${d.grade}</span> ${f1(v)}${mine.length ? `<span class="dot" title="${esc(mine.map(r => r.p.name).join(', '))}"></span>` : ''}</td>`;
  };
  const rows = ranked.map(t => `<tr class="${myOpp[t] ? 'me' : ''}"><td><div class="pl"><img class="hs" src="https://sleepercdn.com/images/team_logos/nfl/${esc(t.toLowerCase())}.png" alt="" onerror="this.style.visibility='hidden'"><b>${esc(t)}</b>${myOpp[t] ? `<span class="sub">${esc(myOpp[t].map(r => r.p.name.split(' ').pop()).join(', '))}</span>` : ''}</div></td>${SS_POS.map(pos => cell(t, pos)).join('')}</tr>`).join('');
  const detail = S.ui.sshm ? hmDetail(L, M, S.ui.sshm) : '';
  return `<div class="controls"><label>Sort by</label><div class="seg">${SS_POS.map(p => `<button data-sspos="${p}" class="${sortPos === p ? 'on' : ''}">${p}</button>`).join('')}</div>
      <div class="seg"><button data-ssrecent="0" class="${!recent ? 'on' : ''}">Season</button><button data-ssrecent="1" class="${recent ? 'on' : ''}">Last 3</button></div></div>
    <div class="card"><h2>Fantasy points allowed per game, by position</h2><div class="hint">In this league's scoring. Green = gives up a lot (start against them), red = stingy. Grade = rank among 32 defenses (A = 5 easiest, F = 5 toughest), blended 60% season / 40% last three. Highlighted rows are defenses your players face this week. Click a cell for the week-by-week.</div>${detail}
    <div class="tw"><table class="hmt"><thead><tr><th>Defense</th>${SS_POS.map(p => `<th class="n sortable" data-sspos="${p}">vs ${p}${sortPos === p ? ' ▾' : ''}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}
function hmDetail(L, M, key) {
  const [t, pos] = key.split('|'); const d = M.def.D[t] && M.def.D[t][pos]; if (!d) return '';
  const ws = M.def.weeks; const lg = M.def.lg[pos]; const mx = Math.max(lg * 2, ...Object.values(d.weekly), 1);
  const W = 26, H = 90, gap = 6, width = ws.length * (W + gap);
  const bars = ws.map((w, i) => { const v = d.weekly[w]; const h = v == null ? 0 : Math.max(2, v / mx * (H - 20)); return v == null ? `<text x="${i * (W + gap) + W / 2}" y="${H - 6}" class="axl" text-anchor="middle">W${w}</text><text x="${i * (W + gap) + W / 2}" y="${H - 24}" class="axl" text-anchor="middle">bye</text>` : `<rect x="${i * (W + gap)}" y="${H - 18 - h}" width="${W}" height="${h}" rx="3" fill="${v > lg ? 'var(--good)' : 'var(--bad)'}" opacity=".85"><title>Week ${w}: ${f1(v)}</title></rect><text x="${i * (W + gap) + W / 2}" y="${H - 22 - h}" class="axv" text-anchor="middle">${Math.round(v)}</text><text x="${i * (W + gap) + W / 2}" y="${H - 6}" class="axl" text-anchor="middle">W${w}</text>`; }).join('');
  const ly = H - 18 - lg / mx * (H - 20);
  return `<div class="hmd top"><div class="sub" style="margin-bottom:6px"><b>${esc(t)} vs ${esc(pos)}</b> — ${f1(d.avg)} allowed per game (#${d.rank}, grade ${d.grade}); dashed line = league average ${f1(lg)}</div>
    <svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" role="img" aria-label="Weekly points allowed by ${esc(t)} to ${esc(pos)}">${bars}<line x1="0" x2="${width}" y1="${ly.toFixed(1)}" y2="${ly.toFixed(1)}" stroke="var(--dim)" stroke-dasharray="3 3"/></svg></div>`;
}

/* ---------- Field: the 22 on the field, as dots ---------- */
const FIELD_W = 600, FIELD_H = 560, LOS = 300;
// offense formation (11 personnel) — x from the offense's left to right, y below the line of scrimmage
const OFF_SLOTS = [['LWR', 60, 300], ['SWR', 135, 318], ['TE', 400, 302], ['RWR', 540, 300], ['QB', 300, 352], ['RB', 300, 404]];
const OL_X = [236, 268, 300, 332, 364];
const DL_ORDER = ['LDE', 'LDT', 'NT', 'DT', 'RDT', 'RDE', 'DL'], LB_ORDER = ['LOLB', 'SLB', 'LILB', 'MLB', 'LB', 'RILB', 'WLB', 'ROLB', 'OLB'];
const DB_SLOTS = { LCB: [60, 214], RCB: [540, 214], NB: [140, 188], FS: [230, 92], SS: [380, 112], DB: [300, 70], WS: [300, 70] };
function spread(n, x0, x1) { return Array.from({ length: n }, (_, i) => n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1)); }

const ESPN_OUT = /out|reserve|unable|suspen|non.?football|ir\b/i, ESPN_Q = /questionable|doubtful|day.?to.?day/i;
// ESPN formation slots -> field coordinates (offense below the line, defense above)
const OFF_XY = { wr1: [60, 300], wr2: [540, 300], wr3: [135, 318], lt: [236, 300], lg: [268, 300], c: [300, 300], rg: [332, 300], rt: [364, 300], te: [400, 302], te1: [400, 302], te2: [200, 302], qb: [300, 352], rb: [300, 428], rb1: [300, 428] };
const DL_KEYS = ['lde', 'ldt', 'nt', 'dt', 'rdt', 'rde'], LB_KEYS = ['wlb', 'lolb', 'lilb', 'mlb', 'rilb', 'rolb', 'slb'];
const DB_XY = { lcb: [60, 214], rcb: [540, 214], nb: [125, 172], fs: [230, 92], ss: [380, 112] };
const SLOT_LABEL = { wr1: 'WR', wr2: 'WR', wr3: 'WR', lt: 'LT', lg: 'LG', c: 'C', rg: 'RG', rt: 'RT', te: 'TE', te1: 'TE', te2: 'TE', qb: 'QB', rb: 'RB', rb1: 'RB', lde: 'DE', rde: 'DE', ldt: 'DT', rdt: 'DT', nt: 'NT', dt: 'DT', wlb: 'LB', slb: 'LB', mlb: 'LB', lilb: 'LB', rilb: 'LB', lolb: 'LB', rolb: 'LB', lcb: 'CB', rcb: 'CB', nb: 'NB', fs: 'FS', ss: 'SS' };

function fieldSide(L, M, team, side) {
  const chart = M.espnDepth[team] && M.espnDepth[team][side];
  if (!chart || !chart.slots) return fieldSideSleeper(L, M, team, side);
  const mine = new Set(L.me ? L.me.players : []), starters = new Set(L.me ? L.me.starters : []);
  const dots = []; const slots = chart.slots;
  const add = (key, x, y) => {
    const arr = slots[key] || []; if (!arr.length) return;
    const i = arr.findIndex(a => !ESPN_OUT.test(a.inj)); const a = i >= 0 ? arr[i] : arr[0];
    const id = M.byEspn[a.espn] || M.byName[norm(a.name) + '|' + team]; const p = id ? L.player(id) : { id: 'espn' + a.espn, name: a.name, inj: '', body: '', pos: SLOT_LABEL[key] || key.toUpperCase() };
    const out = i < 0 || ESPN_OUT.test(a.inj), q = ESPN_Q.test(a.inj) || (!!p.inj && !OUT.has(p.inj));
    dots.push({ slot: SLOT_LABEL[key] || key.toUpperCase(), key, x, y, p, injLabel: out ? 'OUT' : q ? (/doubtful/i.test(a.inj) || p.inj === 'Doubtful' ? 'D' : 'Q') : '', injText: a.inj || p.inj || '',
      sub: i > 0, for: i > 0 ? arr[0] : null, mine: !!id && mine.has(id), starter: !!id && starters.has(id), row: id && (M.rows[id] || (mine.has(id) ? M.row(id) : null)) || null, linked: !!id });
  };
  if (side === 'off') { for (const [k, xy] of Object.entries(OFF_XY)) if (slots[k]) add(k, xy[0], xy[1]); }
  else {
    const dl = DL_KEYS.filter(k => slots[k]); spread(dl.length, 185, 415).forEach((x, i) => add(dl[i], x, 262));
    const lb = LB_KEYS.filter(k => slots[k]); spread(lb.length, 205, 395).forEach((x, i) => add(lb[i], x, 196));
    for (const [k, xy] of Object.entries(DB_XY)) if (slots[k]) add(k, xy[0], xy[1]);
  }
  dots.formation = chart.name;
  return dots;
}
function fieldSideSleeper(L, M, team, side) { // fallback when ESPN has nothing for the team: Sleeper's depth chart (no O-line order)
  const chart = M.depth[team] || {};
  const mine = new Set(L.me ? L.me.players : []), starters = new Set(L.me ? L.me.starters : []);
  const pick = slot => { const arr = chart[slot] || []; if (!arr.length) return null; const first = arr[0]; if (first.out) { const sub = arr.find(x => !x.out); return sub ? { p: sub, sub: true, for: first } : { p: first }; } return { p: first }; };
  const dots = [];
  const add = (slot, x, y, d) => { if (!d) return; const p = d.p; dots.push({ slot: slot.replace(/^[LRS](WR|DE|DT|OLB|ILB|CB)$/, '$1'), key: slot, x, y, p, injLabel: p.inj ? (OUT.has(p.inj) ? 'OUT' : p.inj === 'Doubtful' ? 'D' : 'Q') : '', injText: p.inj || '', sub: !!d.sub, for: d.for ? { name: d.for.name, inj: d.for.inj } : null, mine: mine.has(p.id), starter: starters.has(p.id), row: M.rows[p.id] || (mine.has(p.id) ? M.row(p.id) : null), linked: true }); };
  if (side === 'off') { OFF_SLOTS.forEach(([slot, x, y]) => add(slot, x, y, pick(slot))); OL_X.forEach(x => dots.push({ slot: 'OL', x, y: 300, p: null })); }
  else {
    const dl = DL_ORDER.filter(sl => chart[sl]); spread(dl.length, 185, 415).forEach((x, i) => add(dl[i], x, 262, pick(dl[i])));
    const lb = LB_ORDER.filter(sl => chart[sl]); spread(lb.length, 150, 450).forEach((x, i) => add(lb[i], x, 196, pick(lb[i])));
    for (const [sl, [x, y]] of Object.entries(DB_SLOTS)) if (chart[sl]) add(sl, x, y, pick(sl));
  }
  dots.formation = 'Sleeper depth chart';
  return dots;
}
function dotHtml(L, d, flip) {
  const y = d.y, x = d.x; // flip only moves the labels (defense reads upward, offense downward)
  if (!d.p) return `<g class="fd ol" transform="translate(${x},${y})"><circle r="11"/><text class="fl" y="4" text-anchor="middle">OL</text></g>`;
  const p = d.p; const inj = d.injLabel;
  const cls = ['fd', d.mine ? (d.starter ? 'mine-st' : 'mine') : '', inj === 'OUT' ? 'out' : inj ? 'q' : '', d.sub ? 'sub' : ''].filter(Boolean).join(' ');
  const last = p.name.split(' ').slice(1).join(' ') || p.name;
  const stagger = /^(lg|rg|ldt|rdt|nb)$/.test(d.key || '') ? 12 : 0; // interior linemen sit 32px apart: alternate label rows
  const title = `${p.name} · ${d.slot}${d.sub ? ` (in for ${d.for.name}, ${d.for.inj})` : ''}${d.injText ? ` · ${d.injText}${p.body ? ' ' + p.body : ''}` : ''}${d.row ? ` · ${f1(d.row.adj)} adj proj` : ''}`;
  return `<g class="${cls}" transform="translate(${x},${y})" ${d.linked ? `data-hist="${esc(p.id)}"` : ''}><title>${esc(title)}</title>
    <circle r="15"/><text class="fs" y="4" text-anchor="middle">${esc(d.slot)}</text>
    ${inj ? `<g transform="translate(11,-11)"><rect x="-9" y="-6" width="18" height="12" rx="3" class="tagbg"/><text class="ft" y="3" text-anchor="middle">${inj}</text></g>` : ''}
    <text class="fl" y="${flip ? -22 - stagger : 30 + stagger}" text-anchor="middle">${esc(last)}</text>
    ${d.row && d.mine ? `<text class="fp" y="${flip ? -34 - stagger : 42 + stagger}" text-anchor="middle">${f1(d.row.adj)}</text>` : ''}
    ${d.sub ? `<text class="fsub" y="${flip ? -34 - stagger : 42 + stagger}" text-anchor="middle">in for ${esc(d.for.name.split(' ').pop())}</text>` : ''}</g>`;
}
function ssField(L, M) {
  const games = [...M.env.games].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  if (!games.length) return '<div class="card">No game data for this week yet.</div>';
  const myTeams = (L.me ? L.me.starters : []).map(L.player).filter(p => p.team && ['QB', 'RB', 'WR', 'TE'].includes(p.pos)).map(p => p.team);
  const count = t => myTeams.filter(x => x === t).length;
  let g = games.find(x => x.id === S.ui.ssgame) || games.slice().sort((a, b) => (count(b.home) + count(b.away)) - (count(a.home) + count(a.away)))[0];
  const flipKey = g.id; const defaultOff = count(g.home) >= count(g.away) ? g.home : g.away;
  const off = S.ui.ssflip === flipKey ? (defaultOff === g.home ? g.away : g.home) : defaultOff;
  const def = off === g.home ? g.away : g.home;
  const offDots = fieldSide(L, M, off, 'off'), defDots = fieldSide(L, M, def, 'def');
  const yard = i => `<line x1="0" x2="${FIELD_W}" y1="${i}" y2="${i}" class="yl"/>`;
  const lines = []; for (let y = 60; y < FIELD_H; y += 60) if (y !== LOS) lines.push(yard(y));
  const hashes = []; for (let y = 30; y < FIELD_H; y += 30) hashes.push(`<line x1="230" x2="240" y1="${y}" y2="${y}" class="hl"/><line x1="360" x2="370" y1="${y}" y2="${y}" class="hl"/>`);
  const grades = SS_POS.filter(p => p !== 'K').map(pos => { const d = M.def.D[def] && M.def.D[def][pos]; return d && d.avg != null ? `<span class="chip"><i class="gr g${d.grade} sm">${d.grade}</i> vs ${pos} <span class="sub">${f1(d.avg)}/g</span></span>` : ''; }).join('');
  const env = M.env.byTeam[g.home];
  const wxLine = g.indoor ? '🏟 Indoors' : g.wx ? `${g.wx.temp != null ? g.wx.temp + '° ' : ''}${g.wx.label || ''}${g.wx.wind != null ? ` · 💨 ${g.wx.wind}${g.wx.gust > g.wx.wind ? '–' + g.wx.gust : ''} mph` : ''}${g.wx.rainPct ? ` · 🌧 ${g.wx.rainPct}%` : ''}` : '';
  const injOut = defDots.filter(d => d.sub).map(d => `${d.for.name} (${d.slot}, ${d.for.inj}) → ${d.p.name}`);
  const injQ = defDots.filter(d => d.p && d.injLabel && d.injLabel !== 'OUT').map(d => `${d.p.name} (${d.slot}, ${d.injText})`);
  const offOut = offDots.filter(d => d.sub).map(d => `${d.for.name} (${d.slot}, ${d.for.inj}) → ${d.p.name}`);
  const offQ = offDots.filter(d => d.p && d.injLabel && d.injLabel !== 'OUT').map(d => `${d.p.name} (${d.slot}, ${d.injText})`);
  const svg = `<svg class="field" viewBox="0 0 ${FIELD_W} ${FIELD_H}" role="img" aria-label="${esc(off)} offense against ${esc(def)} defense">
    <rect width="${FIELD_W}" height="${FIELD_H}" class="turf"/>${lines.join('')}${hashes.join('')}
    <line x1="0" x2="${FIELD_W}" y1="${LOS}" y2="${LOS}" class="los"/>
    <image href="https://sleepercdn.com/images/team_logos/nfl/${esc(def.toLowerCase())}.png" x="14" y="14" width="40" height="40" opacity=".9"/>
    <text x="62" y="40" class="tm">${esc(def)} defense <tspan class="tmf">${esc(defDots.formation || '')}</tspan></text>
    <image href="https://sleepercdn.com/images/team_logos/nfl/${esc(off.toLowerCase())}.png" x="14" y="${FIELD_H - 54}" width="40" height="40" opacity=".9"/>
    <text x="62" y="${FIELD_H - 28}" class="tm">${esc(off)} offense <tspan class="tmf">${esc(offDots.formation || '')}</tspan></text>
    ${defDots.map(d => dotHtml(L, d, true)).join('')}${offDots.map(d => dotHtml(L, d, false)).join('')}</svg>`;
  return `<div class="controls"><label>Game</label><select id="ssGame">${games.map(x => `<option value="${esc(x.id)}" ${x.id === g.id ? 'selected' : ''}>${esc(x.away)} @ ${esc(x.home)} · ${esc(M.env.byTeam[x.home].when)}${count(x.home) + count(x.away) ? ` · ${count(x.home) + count(x.away)} of yours` : ''}</option>`).join('')}</select>
      <button class="linkbtn" data-ssflip="${esc(flipKey)}">⇄ Show ${esc(def)} offense vs ${esc(off)} defense</button></div>
    <div class="card"><div class="gtop"><h2 style="margin:0">${esc(off)} offense vs ${esc(def)} defense</h2><span class="sub">${esc(env.when)}${wxLine ? ' · ' + esc(wxLine) : ''}${g.odds ? ' · ' + esc(g.odds.details || '') + (g.odds.ou ? ' · O/U ' + g.odds.ou : '') : ''}</span></div>
      <div class="need">${grades}</div>
      ${svg}
      <div class="legend"><span><i class="fd-key st"></i> your starter</span><span><i class="fd-key bn"></i> on your bench</span><span><i class="fd-key q"></i> Q / D</span><span><i class="fd-key out"></i> out — next man up shown</span><span>Number = adjusted projection</span></div>
      ${injOut.length || injQ.length ? `<div class="hint" style="margin:10px 0 0"><b>${esc(def)} D</b> — ${injOut.length ? `out: ${esc(injOut.join(' · '))}. ` : ''}${injQ.length ? `questionable: ${esc(injQ.join(' · '))}.` : ''}</div>` : ''}
      ${offOut.length || offQ.length ? `<div class="hint" style="margin:6px 0 0"><b>${esc(off)} O</b> — ${offOut.length ? `out: ${esc(offOut.join(' · '))}. ` : ''}${offQ.length ? `questionable: ${esc(offQ.join(' · '))}.` : ''}</div>` : ''}
      <div class="hint" style="margin:8px 0 0">Expected lineups from ESPN's formation depth charts (offense in 11 personnel, defense in its base front plus the nickel back). When a listed starter is out, the next man on the chart is shown with a dashed ring.</div></div>`;
}

/* ---------- This week: one verdict per slot ---------- */
const ORDN = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const POSPL = { QB: 'QBs', RB: 'RBs', WR: 'WRs', TE: 'TEs', K: 'kickers' };
// One plain sentence for the factor that moved the number most
function reasonSentence(r) {
  if (!r) return '';
  if (r.bye) return 'On bye this week.';
  if (r.out) return `Listed ${r.p.inj}${r.p.body ? ` (${r.p.body})` : ''}.`;
  const f = r.factors.filter(x => x.k !== 'home').sort((a, b) => Math.abs(b.mult - 1) - Math.abs(a.mult - 1))[0];
  if (!f) return r.opp ? `${r.home ? 'vs' : '@'} ${r.opp} — nothing unusual: average matchup, no weather in play.` : 'No game found this week.';
  const d = r.defRow, pos = POSPL[r.p.pos] || r.p.pos + 's';
  switch (f.k) {
    case 'matchup': return d.rank <= 16 ? `${r.opp} has been the ${ORDN(d.rank)}-easiest defense for ${pos} this season.` : `${r.opp} has been the ${ORDN(33 - d.rank)}-toughest defense for ${pos} this season.`;
    case 'wind': return f.mult < 1 ? `${r.env.wx.wind} mph wind (gusts ${r.env.wx.gust}) at kickoff — passing game takes a hit.` : `${r.env.wx.wind} mph wind at kickoff — expect more carries.`;
    case 'rain': return `Rain likely at kickoff (${r.env.wx.rainPct}%)${f.mult < 1 ? ' — slightly fewer passes.' : '.'}`;
    case 'snow': return `Snow in the forecast — big drag on the passing game.`;
    case 'cold': return `${r.env.wx.temp}°F at kickoff.`;
    case 'vegas': { const o = r.env.odds; const mine = o.fav === r.p.team ? o.favTotal : o.fav ? o.dogTotal : o.ou / 2; return f.mult > 1 ? `Vegas expects ${f1(mine)} points from ${r.p.team} (O/U ${o.ou}) — a lot of scoring to go around.` : `Vegas expects only ${f1(mine)} points from ${r.p.team} (O/U ${o.ou}).`; }
    case 'script': return f.mult > 1 ? `${r.p.team} is a big favorite — run-heavy game script.` : /favorite/.test(f.label) ? `${r.p.team} is a big favorite — could sit on the lead late.` : `${r.p.team} is a big underdog — fewer carries if they fall behind.`;
    case 'inj': return `Listed ${r.p.inj}${r.p.body ? ` (${r.p.body})` : ''}${r.p.practice ? `, ${r.p.practice.toLowerCase()}` : ''}.`;
    case 'definj': { const n = r.defInj.length; const grp = r.defInj[0].grp === 'secondary' ? 'secondary' : 'front seven'; return `${r.opp} is missing ${n} starter${n > 1 ? 's' : ''} in the ${grp} (${r.defInj.map(x => x.name.split(' ').pop()).join(', ')}).`; }
    default: return f.label + '.';
  }
}
// why the newcomer beats the benched man: his best positive factor, else the benched man's worst, else the raw numbers
function swapReason(rec, cur) {
  const best = r => r.factors.filter(f => f.k !== 'home').sort((a, b) => (b.mult - 1) - (a.mult - 1))[0];
  const worst = r => r.factors.filter(f => f.k !== 'home').sort((a, b) => (a.mult - 1) - (b.mult - 1))[0];
  const up = best(rec); if (up && up.mult > 1.02) return reasonSentence({ ...rec, factors: [up] });
  const dn = cur && worst(cur); if (dn && dn.mult < 0.98) return reasonSentence({ ...cur, factors: [dn] });
  return `Projects ${f1(rec.adj)} to ${cur ? f1(cur.adj) : '0'} this week.`;
}
function slotVerdict(M, x) {
  const flip = M.coinflips.find(c => c.slot === x.slot && x.cur && (c.a.p.id === x.cur.p.id || c.b.p.id === x.cur.p.id));
  if (!x.cur) return { v: 'empty', t: 'Empty', why: x.rec ? `Slot is empty — put in ${x.rec.p.name}.` : 'Slot is empty and nobody on the bench fits.' };
  if (x.cur.bye) return { v: 'bye', t: 'Bye', why: x.rec && x.rec.p.id !== x.cur.p.id ? `${x.cur.p.name} is on bye — start ${x.rec.p.name}.` : `${x.cur.p.name} is on bye and there's no replacement.` };
  if (x.cur.out) return { v: 'out', t: 'Out', why: `${x.cur.p.name} is ${x.cur.p.inj}${x.rec && x.rec.p.id !== x.cur.p.id ? ` — start ${x.rec.p.name}.` : '.'}` };
  const sw = M.swapOut[x.cur.p.id];
  if (sw) return { v: 'sit', t: 'Sit', why: `Start ${sw.rec.p.name} instead (+${f1(sw.gain)}). ${swapReason(sw.rec, x.cur)}` };
  if (flip) { const other = flip.a.p.id === x.cur.p.id ? flip.b : flip.a; const lean = flip.a; return { v: 'flip', t: 'Coin flip', why: `${lean.p.name} by a hair over ${other.p.name} (${f1(flip.a.adj)} vs ${f1(flip.b.adj)}). ${reasonSentence(lean)}` }; }
  return { v: 'start', t: 'Start', why: reasonSentence(x.cur) };
}
function vWeek(L) {
  if (!L.me) return `${leagueMeta(L)}<div class="card">You don't have a team in this league.</div>`;
  const head = (sub) => `<div class="wkhead"><h1>${weekNav(L)}</h1><span class="sub">${sub}</span></div>`;
  if (L.sport !== 'nfl') return `${leagueMeta(L)}${head('Start/sit calls are NFL only — here are your matchups.')}${vMatchups(L)}`;
  const M = S.ss && S.ss.key === `${L.league.league_id}|${L.league.season}|${L.curWeek}` && S.ss.model;
  if (!M) { ensureStartSit(L).then(() => S.tab === 'week' && render()).catch(e => setMain(`<div class="err">${esc(e.message)}</div>`)); return `${leagueMeta(L)}${head('')}<div class="loading">Checking matchups, weather, lines and injuries…</div>`; }
  // my matchup this week
  const mu = L.cur.find(m => m.roster_id === L.me.rid); const opp = mu && L.cur.find(m => m.matchup_id === mu.matchup_id && m.roster_id !== L.me.rid);
  const oppT = opp && L.byRid[opp.roster_id];
  const projOf = m => (m.points || 0) + (m.starters || []).filter(id => id && id !== '0' && !L.player(id).playedThisWk).reduce((a, id) => a + L.player(id).proj, 0);
  const sub = oppT ? `vs <b>${esc(oppT.name)}</b> · proj ${f1(projOf(mu))} – ${f1(projOf(opp))}` : 'No matchup this week';
  const open = S.ui.wkopen || null;
  const rows = M.lineup.map(x => {
    const v = slotVerdict(M, x); const r = x.cur;
    const slot = x.slot.replace('SUPER_FLEX', 'SFLX').replace('WRRB_FLEX', 'W/R').replace('REC_FLEX', 'W/T');
    const key = x.slot + '|' + x.i;
    const det = open === key ? `<div class="vdet"><div class="lbl">Full breakdown</div>${r ? playerLine(L, r, { showRange: true, maxv: Math.max(10, ...M.mine.map(z => z.ceil || 0)) }) : ''}${(() => { const alt = r && M.swapOut[r.p.id] ? M.swapOut[r.p.id].rec : (!r || r.bye || r.out) && x.rec ? x.rec : null; return alt ? `<div class="lbl">Start instead</div>${playerLine(L, alt, { showRange: true, maxv: Math.max(10, ...M.mine.map(z => z.ceil || 0)) })}` : ''; })()}${x.alts.filter(a => !x.rec || a.p.id !== x.rec.p.id).slice(0, 2).map(a => `<div class="lbl">Also eligible</div>${playerLine(L, a, { showRange: false })}`).join('')}</div>` : '';
    return `<div class="vrow" data-wk="${esc(key)}"><span class="vd ${v.v}">${v.t}</span>
      <div class="who">${r ? headshot(L, r.p) : '<span class="hs"></span>'}<div style="min-width:0"><div class="nm">${r ? esc(r.p.name) : '<span class="mute">Empty</span>'} <span class="pos ${POSCLS(slot)}">${esc(slot)}</span>${r && r.opp ? `<span class="sub"> ${r.home ? 'vs' : '@'} ${esc(r.opp)}${r.env && r.env.when ? ' · ' + esc(r.env.when) : ''}</span>` : ''}</div><div class="why">${esc(v.why)}</div></div></div>
      <div class="pts">${r && r.adj > 0 ? `<b>${f1(r.adj)}</b>proj` : ''}</div>${det}</div>`;
  }).join('');
  const gain = M.bestTotal - M.curTotal;
  const summary = M.swaps.length ? `<span class="good">${M.swaps.length} change${M.swaps.length > 1 ? 's' : ''} worth +${f1(gain)}</span>` : M.coinflips.length ? `Lineup's set — ${M.coinflips.length} coin flip${M.coinflips.length > 1 ? 's' : ''} to watch` : '<span class="good">Lineup\'s set. Nothing to do.</span>';
  const wxWarn = [...new Set(M.mine.filter(r => L.me.starters.includes(r.p.id) && r.env && r.env.flags.some(f => f.sev >= 1 && f.k !== 'dome')).map(r => `${r.env.away} @ ${r.env.home}: ${r.env.flags.filter(f => f.k !== 'dome').map(f => f.t).join(', ')}`))];
  return `${leagueMeta(L)}${head(sub)}
    <div class="card"><div class="gtop" style="margin-bottom:4px"><h2 style="margin:0">Your lineup</h2><span class="sub">${summary}</span></div>
      ${wxWarn.length ? `<div class="hint" style="margin:6px 0 8px">🌧 Weather to watch — ${esc(wxWarn.join(' · '))}</div>` : ''}
      ${rows}
      <div class="hint" style="margin:12px 0 0">Tap a row for the full breakdown. Proj = Sleeper's projection adjusted for the defense, weather, betting line and injuries.</div></div>
    <div class="wkfoot"><button data-tab="startsit" data-ssview="field">See the field</button><button data-tab="startsit" data-ssview="games">Weather &amp; lines</button><button data-tab="startsit" data-ssview="defense">Defense grades</button><button data-tab="gm">Ask the GM agent</button></div>`;
}

/* ---------------- agent tool ---------------- */
async function startSitTool(L, args) {
  if (L.sport !== 'nfl') return { error: 'Start/Sit is NFL only' };
  const M = await ensureStartSit(L);
  if (!L.me) return { error: 'the user has no team in this league' };
  const brief = r => ({ player: r.p.name, pos: r.p.pos, team: r.p.team, opponent: r.opp, home: r.home, kickoff: r.env && r.env.when || null, bye: r.bye || undefined, injury: r.p.inj || undefined,
    base_projection: r1(r.base), adjusted_projection: r1(r.adj), floor: r1(r.floor), ceiling: r1(r.ceil), matchup_grade: r.grade, factors: r.factors.map(f => `${f.label} (${pct(f.mult)})`) });
  const names = asArray(args.players);
  if (names.length) {
    const out = names.map(n => { const id = findPlayerId(L, n); return id ? brief(M.row(id)) : { player: n, error: 'not found' }; });
    return { week: L.curWeek, players: out, note: 'Adjusted projection = Sleeper projection blended with season pace, then multiplied by every factor listed.' };
  }
  return {
    week: L.curWeek, current_lineup_total: r1(M.curTotal), best_lineup_total: r1(M.bestTotal),
    lineup: M.lineup.map(x => ({ slot: x.slot, current: x.cur ? brief(x.cur) : null, recommended: x.rec && x.change ? brief(x.rec) : 'keep', gain: x.change ? r1(x.gain) : 0 })),
    recommended_moves: M.swaps.map(x => `${x.slot}: start ${x.rec.p.name}${x.cur ? ` over ${x.cur.p.name}` : ''} (+${f1(x.gain)}) — ${why(x.rec, x.cur)}`),
    coin_flips: M.coinflips.map(c => `${c.slot}: ${c.a.p.name} (${f1(c.a.adj)}) vs ${c.b.p.name} (${f1(c.b.adj)}) — ${why(c.a, c.b)}`),
    bench: M.mine.filter(r => !L.me.starters.includes(r.p.id)).sort((a, b) => b.adj - a.adj).slice(0, 8).map(brief),
    weather_warnings: [...new Set(M.mine.filter(r => L.me.starters.includes(r.p.id) && r.env && r.env.flags.some(f => f.sev >= 1 && f.k !== 'dome')).map(r => `${r.p.name}: ${r.env.away} @ ${r.env.home} — ${r.env.flags.filter(f => f.k !== 'dome').map(f => f.t).join(', ')}`))]
  };
}

function bindStartSit() {
  document.querySelectorAll('[data-wk]').forEach(row => row.onclick = e => { if (e.target.closest('[data-hist]')) return; S.ui.wkopen = S.ui.wkopen === row.dataset.wk ? null : row.dataset.wk; render(); });
  document.querySelectorAll('.wkfoot [data-tab]').forEach(b => b.onclick = () => { if (b.dataset.ssview) S.ui.ssview = b.dataset.ssview; S.tab = b.dataset.tab; history.replaceState(null, '', '#' + S.tab); render(); });
  document.querySelectorAll('[data-ssview]').forEach(b => b.onclick = () => { S.ui.ssview = b.dataset.ssview; render(); });
  document.querySelectorAll('[data-sspos]').forEach(b => b.onclick = () => { S.ui.sspos = b.dataset.sspos; render(); });
  document.querySelectorAll('[data-ssrecent]').forEach(b => b.onclick = () => { S.ui.ssrecent = b.dataset.ssrecent; render(); });
  document.querySelectorAll('[data-hm]').forEach(c => c.onclick = () => { S.ui.sshm = S.ui.sshm === c.dataset.hm ? null : c.dataset.hm; render(); });
  const gs = $('#ssGame'); if (gs) gs.onchange = () => { S.ui.ssgame = gs.value; S.ui.ssflip = null; render(); };
  document.querySelectorAll('[data-ssflip]').forEach(b => b.onclick = () => { S.ui.ssflip = S.ui.ssflip === b.dataset.ssflip ? null : b.dataset.ssflip; render(); });
}
