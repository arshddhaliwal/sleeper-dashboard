'use strict';
const API = 'https://api.sleeper.app/v1';
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f1 = n => (n == null || isNaN(n)) ? '–' : (Math.round(n * 10) / 10).toFixed(1);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
};
async function j(url, fallback) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return await r.json();
  } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}

const _jcache = new Map();
function jc(url, fallback) { // memoised per page session; shared data (players, projections, schedule) is fetched once
  if (!_jcache.has(url)) _jcache.set(url, j(url, fallback));
  return _jcache.get(url);
}
const leagueKind = l => { const t = l.settings && l.settings.type; return t === 2 ? 'dynasty' : t === 1 ? 'keeper' : 'redraft'; };
const KIND_LABEL = { dynasty: 'Dynasty', keeper: 'Keeper', redraft: 'Redraft' };
const S = { user: null, leagues: [], states: {}, tab: 'overview', L: null, ui: {} };
// Demo mode (?demo=1): real league data, but every team/manager name and avatar is replaced with a neutral alias.
const DEMO_USER = 'EOSARSH';
const DEMO_NAMES = ['Gridiron Gang', 'Red Zone Rebels', 'Blitz Brigade', 'End Zone Empire', 'Hail Mary Heroes', 'Fourth & Long', 'Pigskin Pirates', 'Two-Minute Drill', 'Audible All-Stars', 'Sunday Funday', 'Waiver Wire Wizards', 'Taxi Squad Titans', 'Bye Week Bandits', 'Goal Line Stand', 'Play Action Pros', 'Redshirt Rookies'];

/* ---------------- slot eligibility ---------------- */
const SLOT = {
  FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'], DL: ['DL', 'DE', 'DT'], DB: ['DB', 'CB', 'S'],
  G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
};
const eligible = slot => SLOT[slot] || [slot];
const NON_LINEUP = new Set(['BN', 'IR', 'TAXI']);
const OUT = new Set(['IR', 'Out', 'PUP', 'Sus', 'NA', 'DNR', 'COV']);
const NO_TRADE = new Set(['K', 'DEF']); // kickers/defenses aren't real trade chips

/* ---------------- boot ---------------- */
function init() {
  const qs = new URLSearchParams(location.search);
  S.demo = qs.get('demo') === '1';
  if (S.demo) document.body.classList.add('demo');
  const u = S.demo ? DEMO_USER : (qs.get('u') || store.get('sd_user', ''));
  S.tab = (location.hash || '#overview').slice(1);
  $('#userInput').value = S.demo ? '' : u;
  if (S.demo) { $('#userInput').placeholder = 'Demo mode — enter your own username'; }
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    S.tab = b.dataset.tab; history.replaceState(null, '', '#' + S.tab); render();
  });
  $('#userForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#userInput').value.trim();
    if (!name) return;
    if (S.demo) { location.href = location.pathname + '?u=' + encodeURIComponent(name); return; }
    if (S.user && S.user.username === name.toLowerCase() && $('#leagueSelect').value) return loadLeague($('#leagueSelect').value);
    await loadUser(name);
  });
  $('#leagueSelect').addEventListener('change', e => loadLeague(e.target.value));
  $('#refreshBtn').addEventListener('click', () => S.L && loadLeague(S.L.league.league_id));
  markTab();
  if (u) loadUser(u, qs.get('l') || (S.demo ? '1365132656831913984' : null)); // demo opens on the dynasty league
}

function markTab() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const badge = $('#alertBadge');
  if (badge) { const n = (S.allAlerts || []).filter(a => a.sev === 'crit').length; badge.textContent = n || ''; badge.style.display = n ? '' : 'none'; }
}
function setMain(html) { $('#main').innerHTML = html; }

async function loadUser(name, wantLeague) {
  setMain('<div class="loading">Finding your leagues…</div>');
  try {
    const user = await j(`${API}/user/${encodeURIComponent(name)}`);
    if (!user || !user.user_id) throw new Error(`No Sleeper user named “${name}”.`);
    S.user = user; if (!S.demo) store.set('sd_user', user.username || name);
    const [nfl, nba] = await Promise.all([j(`${API}/state/nfl`, {}), j(`${API}/state/nba`, {})]);
    S.states = { nfl, nba };
    const lists = await Promise.all(['nfl', 'nba'].map(sp =>
      j(`${API}/user/${user.user_id}/leagues/${sp}/${(S.states[sp].league_season || S.states[sp].season)}`, [])));
    S.leagues = lists.flat().filter(Boolean);
    if (!S.leagues.length) throw new Error('No current-season NFL or NBA leagues found for this user.');
    const sel = $('#leagueSelect');
    sel.innerHTML = S.leagues.map(l => `<option value="${l.league_id}">${l.sport.toUpperCase()} · ${esc(l.name.trim())} · ${KIND_LABEL[leagueKind(l)]}</option>`).join('');
    const pick = wantLeague && S.leagues.find(l => l.league_id === wantLeague) ? wantLeague
      : (store.get('sd_league_' + user.user_id) && S.leagues.find(l => l.league_id === store.get('sd_league_' + user.user_id)) ? store.get('sd_league_' + user.user_id) : S.leagues[0].league_id);
    sel.value = pick;
    S.allAlerts = null; loadAllAlerts();
    await loadLeague(pick);
  } catch (e) {
    setMain(`<div class="err">${esc(e.message)}</div>`);
  }
}

async function loadLeague(id) {
  setMain('<div class="loading">Loading league…</div>');
  try {
    if (!S.demo) store.set('sd_league_' + S.user.user_id, id);
    const q = new URLSearchParams(S.demo ? { demo: 1, l: id } : { u: S.user.username, l: id });
    history.replaceState(null, '', '?' + q + '#' + S.tab);
    const league = await j(`${API}/league/${id}`);
    const sport = league.sport;
    const st = S.states[sport] || await j(`${API}/state/${sport}`, {});
    const season = league.season;
    const curWeek = Math.max(1, (st.season === season ? (st.display_week || st.week) : 0) || league.settings.last_scored_leg || 1);
    const startWeek = league.settings.start_week || 1;
    const weeks = []; for (let w = startWeek; w <= curWeek; w++) weeks.push(w);
    const sc = league.scoring_settings || {};
    const kindNow = leagueKind(league);
    const qbs = (league.roster_positions || []).includes('SUPER_FLEX') || (league.roster_positions || []).filter(x => x === 'QB').length > 1 ? 2 : 1;
    const valuesUrl = sport === 'nfl' ? `/api/values?dynasty=${kindNow === 'redraft' ? 0 : 1}&teams=${league.total_rosters || 12}&ppr=${sc.rec === 1 ? 1 : sc.rec === 0.5 ? 0.5 : 0}&qbs=${qbs}` : null;
    const [users, rosters, traded, extra, ...mus] = await Promise.all([
      j(`${API}/league/${id}/users`, []),
      j(`${API}/league/${id}/rosters`, []),
      j(`${API}/league/${id}/traded_picks`, []),
      sportData(sport, season, curWeek),
      ...weeks.map(w => j(`${API}/league/${id}/matchups/${w}`, []))
    ]);
    const values = valuesUrl ? await jc(valuesUrl, null) : null;
    S.L = build({ league, users, rosters, traded, mus, weeks, curWeek, sport, values, ...extra });
    S.injChanges = injuryDiff(S.L);
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    render();
  } catch (e) {
    setMain(`<div class="err">Couldn't load this league: ${esc(e.message)}</div>`);
  }
}

async function sportData(sport, season, week) {
  const [players, stats, wkStats, proj, schedule, trendAdd, trendDrop, prevStats] = await Promise.all([
    jc(`/api/players?sport=${sport}`),
    jc(`${API}/stats/${sport}/regular/${season}`, {}),
    jc(`${API}/stats/${sport}/regular/${season}/${week}`, {}),
    jc(`${API}/projections/${sport}/regular/${season}/${week}`, {}),
    sport === 'nfl' ? jc(`https://api.sleeper.app/schedule/nfl/regular/${season}`, []) : Promise.resolve([]),
    jc(`${API}/players/${sport}/trending/add?lookback_hours=24&limit=40`, []),
    jc(`${API}/players/${sport}/trending/drop?lookback_hours=24&limit=40`, []),
    // no free market values for NBA: last season smooths out small early-season samples
    sport === 'nba' ? jc(`${API}/stats/${sport}/regular/${+season - 1}`, {}) : Promise.resolve({})
  ]);
  return { players, stats, wkStats, proj, schedule, trendAdd, trendDrop, prevStats };
}
// Compare injury statuses for my players with what this browser saw last time.
function injuryDiff(L) {
  if (!L.me) return [];
  const key = 'sd_inj_' + L.league.league_id;
  const prev = store.get(key, null);
  const now = {}; L.me.players.forEach(id => now[id] = L.player(id).inj || '');
  store.set(key, now);
  if (!prev) return [];
  return Object.keys(now).filter(id => id in prev && prev[id] !== now[id]).map(id => ({ p: L.player(id), from: prev[id] || 'Healthy', to: now[id] || 'Healthy' }));
}

/* ---------------- model ---------------- */
function build(d) {
  const { league, sport } = d;
  const sc = league.scoring_settings || {};
  const pts = s => { if (!s) return 0; let t = 0; for (const k in sc) { const v = s[k]; if (v) t += v * sc[k]; } return t; };
  const games = s => s ? (sport === 'nfl' ? (s.gms_active ?? s.gp ?? 0) : (s.gp ?? 0)) : 0;
  const P = d.players;
  const info = id => {
    const a = P[id];
    if (!a) return { id, name: /^[A-Z]{2,3}$/.test(id) ? id + ' D/ST' : id, pos: /^[A-Z]{2,3}$/.test(id) ? 'DEF' : '?', positions: ['DEF'], team: /^[A-Z]{2,3}$/.test(id) ? id : '', age: null, exp: null, inj: '', body: '', newsAt: 0, espn: null, practice: '' };
    const positions = a[1].split('/');
    return { id, name: a[0], pos: positions[0], positions, team: a[2], age: a[3], exp: a[4], inj: a[5], body: a[6] || '', newsAt: a[7] || 0, espn: a[8] ? String(a[8]) : null, practice: a[9] || '' };
  };
  // weekly league-official points
  const weekly = {};
  d.mus.forEach((arr, i) => {
    const w = d.weeks[i];
    (arr || []).forEach(m => { for (const [pid, v] of Object.entries(m.players_points || {})) (weekly[pid] = weekly[pid] || {})[w] = v; });
  });
  // this week's games: byes and locked (already started) players
  const wkGames = {};
  (d.schedule || []).filter(g => g.week === d.curWeek).forEach(g => { wkGames[g.home] = g; wkGames[g.away] = g; });
  const haveSched = Object.keys(wkGames).length > 0;
  const V = (d.values && d.values.players) || {};
  const pcache = {};
  const player = id => {
    if (pcache[id]) return pcache[id];
    const p = info(id);
    const s = d.stats[id];
    p.total = pts(s); p.gp = games(s); p.ppg = p.gp ? p.total / p.gp : 0;
    const ps = d.prevStats && d.prevStats[id]; const pgp = games(ps);
    if (pgp) { const w = Math.max(0, 1 - p.gp / 20); p.prevPpg = pts(ps) / pgp; p.blendPpg = (p.total + pts(ps) * w) / (p.gp + pgp * w); } else p.blendPpg = p.ppg;
    p.weeks = weekly[id] || {};
    const lw = d.curWeek - 1; p.lastWk = p.weeks[lw] != null ? p.weeks[lw] : null;
    p.thisWk = p.weeks[d.curWeek] != null ? p.weeks[d.curWeek] : null;
    const ws = d.wkStats[id]; p.playedThisWk = !!(ws && games(ws));
    p.proj = pts(d.proj[id]);
    p.out = OUT.has(p.inj);
    const g = p.team ? wkGames[p.team] : null;
    p.bye = sport === 'nfl' && haveSched && !!p.team && !g;
    p.locked = !!g && g.status !== 'pre_game';
    p.game = g || null;
    const v = V[id]; p.value = v ? v[0] : null; p.trend = v ? v[1] : 0;
    return (pcache[id] = p);
  };
  const userMap = Object.fromEntries(d.users.map(u => [u.user_id, u]));
  const teams = d.rosters.map(r => {
    const u = userMap[r.owner_id] || {};
    const s = r.settings || {};
    const avatar = (u.metadata && u.metadata.avatar) || (u.avatar ? `https://sleepercdn.com/avatars/thumbs/${u.avatar}` : '');
    return {
      rid: r.roster_id, owner_id: r.owner_id, co: r.co_owners || [],
      name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
      owner: u.display_name || 'Orphan', avatar,
      wins: s.wins || 0, losses: s.losses || 0, ties: s.ties || 0,
      pf: (s.fpts || 0) + (s.fpts_decimal || 0) / 100,
      pa: (s.fpts_against || 0) + (s.fpts_against_decimal || 0) / 100,
      maxpf: (s.ppts || 0) + (s.ppts_decimal || 0) / 100,
      streak: (r.metadata && r.metadata.streak) || '',
      players: (r.players || []).filter(Boolean), starters: (r.starters || []).filter(x => x && x !== '0'), slotsRaw: r.starters || [],
      taxi: new Set(r.taxi || []), reserve: new Set(r.reserve || [])
    };
  });
  if (S.demo) { // anonymise: stable alias per roster, nothing identifying left
    teams.forEach((t, i) => { const mine = t.owner_id === S.user.user_id; t.name = mine ? 'Your Team (demo)' : DEMO_NAMES[i % DEMO_NAMES.length]; t.owner = mine ? 'You' : `Manager ${t.rid}`; t.avatar = ''; });
  }
  const byRid = Object.fromEntries(teams.map(t => [t.rid, t]));
  const me = teams.find(t => t.owner_id === S.user.user_id || t.co.includes(S.user.user_id)) || null;
  const owner = {}; teams.forEach(t => t.players.forEach(p => owner[p] = t.rid));
  const slots = (league.roster_positions || []).filter(s => !NON_LINEUP.has(s));
  // standings
  const standings = [...teams].sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - a.pf));
  standings.forEach((t, i) => t.rank = i + 1);
  // picks
  const picks = computePicks(league, teams, d.traded);
  // matchups this week
  const cur = d.mus[d.mus.length - 1] || [];
  const kind = leagueKind(league);
  const hasPicks = kind !== 'redraft';
  // Carry-over rules: full dynasty (everyone stays), limited keepers, or none. Sleeper's max_keepers defaults to 1
  // even when unused, so only keeper leagues or a dynasty with >1 set default to limited; viewers can override.
  const setK = league.settings.max_keepers || 0;
  const defRule = kind === 'keeper' || (kind === 'dynasty' && setK > 1) ? 'limited' : kind === 'dynasty' ? 'all' : 'none';
  const keepRule = store.get('sd_keeprule_' + league.league_id, defRule);
  const usesKeepers = keepRule === 'limited';
  const maxKeepers = usesKeepers ? Math.max(1, setK) : 0;
  const rank = (arr) => Object.fromEntries((arr || []).map((x, i) => [x.player_id, { rank: i + 1, count: x.count }]));
  // team points per completed week (current week excluded while it's in progress)
  const weekPts = d.mus.map((arr, i) => ({ w: d.weeks[i], pts: Object.fromEntries((arr || []).filter(m => m.matchup_id).map(m => [m.roster_id, m.points || 0])) }))
    .filter(x => x.w < d.curWeek && Object.values(x.pts).some(v => v > 0)).map(x => x.pts);
  return { league, sport, teams, byRid, me, owner, slots, player, standings, picks, cur, weeks: d.weeks, curWeek: d.curWeek, stats: d.stats, scoring: sc, kind, hasPicks, maxKeepers, usesKeepers, keepRule, setK, weekPts,
    values: d.values, haveSched, trendAdd: d.trendAdd || [], trendDrop: d.trendDrop || [], addRank: rank(d.trendAdd), dropRank: rank(d.trendDrop), proj: d.proj };
}

function computePicks(league, teams, traded) {
  const rounds = league.settings.draft_rounds || 3;
  const base = +league.season;
  const preDraft = ['pre_draft', 'drafting'].includes(league.status);
  const seasons = new Set();
  for (let y = preDraft ? base : base + 1; y <= base + 3; y++) seasons.add(String(y));
  const own = {};
  for (const y of seasons) for (let r = 1; r <= rounds; r++) teams.forEach(t => own[`${y}|${r}|${t.rid}`] = t.rid);
  (traded || []).forEach(p => { const k = `${p.season}|${p.round}|${p.roster_id}`; if (k in own) own[k] = p.owner_id; });
  const byOwner = {};
  for (const [k, o] of Object.entries(own)) { const [y, r, orig] = k.split('|'); (byOwner[o] = byOwner[o] || []).push({ y, r: +r, orig: +orig }); }
  Object.values(byOwner).forEach(a => a.sort((x, z) => (x.y - z.y) || (x.r - z.r)));
  return { own, byOwner, seasons: [...seasons], rounds };
}

/* ---------------- lineup optimizer ---------------- */
function optimal(L, pids, { healthyOnly = true } = {}) {
  const pool = pids.map(L.player).filter(p => p.ppg > 0 && (!healthyOnly || !p.out));
  const order = [...L.slots].map((s, i) => ({ s, i, n: eligible(s).length })).sort((a, b) => a.n - b.n);
  const used = new Set(); const lineup = []; let total = 0;
  for (const { s, i } of order) {
    const el = eligible(s);
    let best = null;
    for (const p of pool) if (!used.has(p.id) && p.positions.some(x => el.includes(x)) && (!best || p.ppg > best.ppg)) best = p;
    if (best) { used.add(best.id); total += best.ppg; }
    lineup[i] = { slot: s, p: best };
  }
  return { lineup, total, used };
}
function activePids(L, t) { return t.players.filter(p => !t.reserve.has(p) && !t.taxi.has(p)); }

/* ---------------- render ---------------- */
function render() {
  markTab();
  if (!S.L) return;
  const fn = { overview: vOverview, alerts: vAlerts, team: vTeam, matchups: vMatchups, teams: vTeams, trades: vTrades, check: vCheck, news: vNews, players: vPlayers, history: vHistory, strategy: vStrategy }[S.tab] || vOverview;
  setMain(fn(S.L));
  bind();
}

const POSCLS = p => esc((p || '').split('/')[0]);
function headshot(L, p) {
  if (p.pos === 'DEF') return `<img class="hs" loading="lazy" src="https://sleepercdn.com/images/team_logos/nfl/${esc(p.id.toLowerCase())}.png" onerror="this.style.visibility='hidden'" alt="">`;
  return `<img class="hs" loading="lazy" src="https://sleepercdn.com/content/${L.sport}/players/thumb/${esc(p.id)}.jpg" onerror="this.style.visibility='hidden'" alt="">`;
}
function injTag(p) {
  if (!p.inj) return '';
  const cls = OUT.has(p.inj) ? 'inj' : 'q';
  return `<span class="tag ${cls}">${esc(p.inj === 'Questionable' ? 'Q' : p.inj === 'Doubtful' ? 'D' : p.inj)}</span>`;
}
function plCell(L, p, extra = '') {
  return `<div class="pl">${headshot(L, p)}<div><div class="nm"><span class="nmlink" data-hist="${esc(p.id)}" title="See how he got here">${esc(p.name)}</span>${injTag(p)}${extra}</div><div class="sub">${esc(p.team || 'FA')}${p.age ? ' · ' + p.age : ''}</div></div></div>`;
}
function teamCell(t, sub = true) {
  return `<div class="pl">${t.avatar ? `<img class="av" src="${esc(t.avatar)}" alt="" onerror="this.style.visibility='hidden'">` : '<span class="av"></span>'}<div><div class="nm">${esc(t.name)}</div>${sub ? `<div class="sub">${esc(t.owner)}</div>` : ''}</div></div>`;
}
function spark(L, p) {
  const ws = L.weeks.slice(0, -1).length ? L.weeks : L.weeks;
  const vals = ws.map(w => p.weeks[w] ?? 0);
  if (vals.every(v => !v)) return '<span class="mute">–</span>';
  const W = 84, H = 22, mx = Math.max(...vals, 1);
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1) * W).toFixed(1)},${(H - 2 - v / mx * (H - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}
const rec = t => `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`;
function leagueMeta(L) {
  const st = L.league.settings, sc = L.scoring;
  const bits = [`${L.teams.length} teams`];
  if (L.sport === 'nfl') bits.push(sc.rec === 1 ? 'PPR' : sc.rec === 0.5 ? 'Half-PPR' : sc.rec ? sc.rec + ' PPR' : 'Standard');
  if (st.playoff_teams) bits.push(`${st.playoff_teams}-team playoffs`);
  bits.push(L.keepRule === 'all' ? 'all players carry over' : L.keepRule === 'limited' ? `${L.maxKeepers} keeper${L.maxKeepers > 1 ? 's' : ''}` : 'no keepers');
  if (st.taxi_slots) bits.push(`${st.taxi_slots} taxi`);
  bits.push(L.hasPicks ? 'future picks tradeable' : 'no future picks');
  return `<div class="lgmeta">${S.demo ? '<span class="badge demo">Demo · names hidden</span>' : ''}<span class="badge ${L.kind}">${KIND_LABEL[L.kind]}</span><span class="sub">${esc(L.league.name.trim())} · ${bits.join(' · ')}</span></div>`;
}

/* ---------- Overview ---------- */
function draftOrder(L, rule) {
  const n = L.league.settings.playoff_teams || 0;
  const st = L.standings;
  const playoff = new Set(st.slice(0, n).map(t => t.rid));
  const non = st.filter(t => !playoff.has(t.rid)), po = st.filter(t => playoff.has(t.rid));
  let order;
  if (rule === 'record') order = [...st].reverse();
  else if (rule === 'pf') order = [...non].sort((a, b) => a.pf - b.pf).concat([...po].reverse());
  else order = [...non].sort((a, b) => a.maxpf - b.maxpf).concat([...po].reverse());
  return { order, playoff, n };
}
function gbText(L, t) {
  const n = L.league.settings.playoff_teams || 0; const cut = L.standings[n - 1];
  if (!cut || t.rank <= n) return '–';
  const gb = ((cut.wins - t.wins) + (t.losses - cut.losses)) / 2;
  return gb <= 0 ? 'Tied' : (gb % 1 ? gb.toFixed(1) : gb) + ' GB';
}
function vOverview(L) {
  const me = L.me;
  const ruleKey = 'sd_rule_' + L.league.league_id;
  const rule = store.get(ruleKey, 'maxpf');
  const { order, playoff } = draftOrder(L, rule);
  const nextSeason = L.picks.seasons[0];
  const mySlot = me ? order.findIndex(t => t.rid === me.rid) + 1 : 0;
  const myOpt = me ? optimal(L, activePids(L, me)) : null;
  const leagueAvgPF = L.teams.reduce((a, t) => a + t.pf, 0) / (L.teams.length || 1);
  let kp = '';
  if (me) {
    kp = `<div class="kpis">
      <div class="kpi"><div class="l">Record</div><div class="v">${rec(me)}</div><div class="s">#${me.rank} of ${L.teams.length} · ${esc(me.streak || '—')}</div></div>
      <div class="kpi"><div class="l">Points for</div><div class="v">${f1(me.pf)}</div><div class="s">League avg ${f1(leagueAvgPF)}</div></div>
      <div class="kpi"><div class="l">Max PF</div><div class="v">${f1(me.maxpf)}</div><div class="s">${me.maxpf ? Math.round(me.pf / me.maxpf * 100) + '% lineup efficiency' : ''}</div></div>
      ${L.hasPicks ? `<div class="kpi"><div class="l">Proj. ${esc(nextSeason || '')} pick</div><div class="v">#${mySlot}</div><div class="s">${playoff.has(me.rid) ? 'Currently in playoff spot' : 'Currently missing playoffs'}</div></div>` : `<div class="kpi"><div class="l">Playoffs</div><div class="v">${playoff.has(me.rid) ? 'In' : gbText(L, me)}</div><div class="s">${playoff.has(me.rid) ? 'Currently in a playoff spot' : 'behind the last playoff spot'}</div></div>`}
      <div class="kpi"><div class="l">Healthy lineup</div><div class="v">${f1(myOpt.total)}</div><div class="s">pts/${L.sport === 'nfl' ? 'week' : 'game-slot'} at season pace</div></div>
    </div>`;
  }
  const stRows = L.standings.map((t, i) => `<tr class="${me && t.rid === me.rid ? 'me' : ''} ${i + 1 === (L.league.settings.playoff_teams || 0) ? 'line' : ''}">
      <td class="n">${t.rank}</td><td>${teamCell(t)}</td><td class="n">${rec(t)}</td><td class="n">${f1(t.pf)}</td><td class="n">${f1(t.pa)}</td><td class="n">${f1(t.maxpf)}</td><td class="n">${t.maxpf ? Math.round(t.pf / t.maxpf * 100) + '%' : '–'}</td><td class="n mute">${gbText(L, t)}</td><td>${esc(t.streak)}</td></tr>`).join('');
  const r1Owner = rid => { const o = L.picks.own[`${nextSeason}|1|${rid}`]; return o && o !== rid ? L.byRid[o] : null; };
  const doRows = order.map((t, i) => {
    const o = r1Owner(t.rid); const gap = i > 0 && rule === 'maxpf' && !playoff.has(t.rid) ? t.maxpf - order[i - 1].maxpf : null;
    return `<tr class="${me && (t.rid === me.rid || (o && o.rid === me.rid)) ? 'me' : ''} ${i + 1 === order.filter(x => !playoff.has(x.rid)).length && rule !== 'record' ? 'line' : ''}">
      <td class="n">${i + 1}</td><td>${teamCell(t, false)}</td><td class="n">${rec(t)}</td><td class="n">${f1(rule === 'pf' ? t.pf : t.maxpf)}</td><td class="n mute">${gap != null ? '+' + f1(gap) : ''}</td><td>${o ? `<span class="sub">owned by</span> ${esc(o.name)}` : '<span class="mute">own</span>'}</td></tr>`;
  }).join('');
  const standingsCard = `<div class="card"><h2>Standings</h2><div class="hint">Dashed line = playoff cut (${L.league.settings.playoff_teams || '?'} teams). GB = games behind the last playoff spot.</div><div class="tw"><table><thead><tr><th class="n">#</th><th>Team</th><th class="n">W-L</th><th class="n">PF</th><th class="n">PA</th><th class="n">Max PF</th><th class="n">Eff</th><th class="n" title="Games behind the last playoff spot">GB</th><th>Strk</th></tr></thead><tbody>${stRows}</tbody></table></div></div>`;
  const draftCard = !L.hasPicks ? '' : `
    <div class="card"><h2>Projected ${esc(nextSeason || '')} draft order</h2>
      <div class="controls"><label>Rule</label><div class="seg" data-rule-key="${ruleKey}">
        <button data-rule="maxpf" class="${rule === 'maxpf' ? 'on' : ''}">Non-playoff → lowest Max PF</button>
        <button data-rule="pf" class="${rule === 'pf' ? 'on' : ''}">Non-playoff → lowest PF</button>
        <button data-rule="record" class="${rule === 'record' ? 'on' : ''}">Worst record</button></div></div>
      <div class="hint">If the season ended today. Playoff teams are listed in reverse standings order.</div>
      <div class="tw"><table><thead><tr><th class="n">Pick</th><th>Team</th><th class="n">W-L</th><th class="n">${rule === 'pf' ? 'PF' : 'Max PF'}</th><th class="n">Gap</th><th>1st owned by</th></tr></thead><tbody>${doRows}</tbody></table></div></div>`;
  return `${leagueMeta(L)}${alertStrip(L)}${kp}<div class="grid ${L.hasPicks ? 'g2' : ''}">
    ${standingsCard}${draftCard}
  </div>`;
}

/* ---------- Roster table ---------- */
function rosterTable(L, t, { keepers = null } = {}) {
  const opt = optimal(L, activePids(L, t));
  const sortKey = S.ui.rsort || 'pos';
  const ord = L.sport === 'nfl' ? ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] : ['PG', 'SG', 'G', 'SF', 'PF', 'F', 'C'];
  const rows = t.players.map(L.player).sort((a, b) => {
    if (sortKey === 'ppg') return b.ppg - a.ppg;
    if (sortKey === 'total') return b.total - a.total;
    if (sortKey === 'age') return (a.age || 99) - (b.age || 99);
    const pa = ord.indexOf(a.pos), pb = ord.indexOf(b.pos);
    return ((pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb)) || (b.ppg - a.ppg);
  });
  const body = rows.map(p => {
    const role = t.reserve.has(p.id) ? '<span class="tag inj">IR</span>' : t.taxi.has(p.id) ? '<span class="tag tx">TAXI</span>' : t.starters.includes(p.id) ? '<span class="tag st">START</span>' : '<span class="mute">BN</span>';
    const best = opt.used.has(p.id) ? '<span class="good" title="In your best healthy lineup by season pace">●</span>' : '';
    const k = keepers ? `<td><input type="checkbox" class="chk" data-keep="${esc(p.id)}" ${keepers.has(p.id) ? 'checked' : ''} aria-label="Keeper"></td>` : '';
    return `<tr>${k}<td><span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></td><td>${plCell(L, p, keepers && keepers.has(p.id) ? '<span class="tag keep">KEEP</span>' : '')}</td><td>${role}</td><td class="n">${best}</td><td class="n">${p.exp != null ? p.exp : '–'}</td><td class="n">${p.gp || 0}</td><td class="n">${f1(p.total)}</td><td class="n"><b>${f1(p.ppg)}</b></td><td class="n">${f1(p.lastWk)}</td><td>${spark(L, p)}</td></tr>`;
  }).join('');
  const th = (k, label, cls = 'n') => `<th class="${cls} sortable" data-rsort="${k}">${label}${sortKey === k ? ' ▾' : ''}</th>`;
  return `<div class="tw"><table><thead><tr>${keepers ? '<th>Keep</th>' : ''}${th('pos', 'Pos', '')}<th>Player</th><th>Slot</th><th class="n" title="In best healthy lineup">Best</th><th class="n">Yrs</th><th class="n">GP</th>${th('total', 'Total')}${th('ppg', 'PPG')}<th class="n">Last wk</th><th>Weekly</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- My Team ---------- */
function vTeam(L) {
  if (!L.me) return `<div class="card">You don't have a team in this league.</div>`;
  const keep = new Set(store.get('sd_keep_' + L.league.league_id, []));
  const maxK = L.maxKeepers;
  const keepHint = L.usesKeepers ? `Tick your keepers — the Trade Finder treats everyone else as tradeable. Up to ${maxK} keeper${maxK > 1 ? 's' : ''}. Selected: <b id="keepCount">${keep.size}</b>. `
    : L.keepRule === 'all' ? 'Full dynasty — your whole roster carries over, so there are no keepers to pick. ' : 'No keepers — your whole roster is fair game in trades. ';
  const opt = (v, label) => `<button data-keeprule="${v}" class="${L.keepRule === v ? 'on' : ''}">${label}</button>`;
  const ruleSeg = `<div class="controls"><label>Carry-over rules</label><div class="seg">${L.kind === 'redraft' ? opt('none', 'No keepers') : opt('all', 'Full dynasty')}${opt('limited', `Keepers (${Math.max(1, L.setK)})`)}</div><span class="sub">Set from your Sleeper league settings — change it if your league plays differently.</span></div>`;
  return `${leagueMeta(L)}${ruleSeg}<div class="card"><h2>${esc(L.me.name)} <span class="sub">${rec(L.me)}</span></h2>
    <div class="hint">${keepHint}PPG uses this league's scoring; ● marks your best healthy lineup at season pace.</div>
    ${rosterTable(L, L.me, { keepers: L.usesKeepers ? keep : null })}</div>
    ${L.hasPicks ? picksCard(L, L.me) : ''}`;
}
function picksCard(L, t) {
  const ps = L.picks.byOwner[t.rid] || [];
  if (!ps.length) return '';
  const items = ps.map(p => `<span class="pick ${p.r === 1 ? 'r1' : ''}">${p.y} R${p.r}${p.orig !== t.rid ? ' · ' + esc(L.byRid[p.orig] ? L.byRid[p.orig].name : '#' + p.orig) : ''}</span>`).join('');
  const lost = [];
  for (const [k, o] of Object.entries(L.picks.own)) { const [y, r, orig] = k.split('|'); if (+orig === t.rid && o !== t.rid) lost.push(`<span class="pick">${y} R${r} → ${esc(L.byRid[o] ? L.byRid[o].name : '#' + o)}</span>`); }
  return `<div class="card" style="margin-top:16px"><h2>Draft picks</h2><div class="picks">${items}</div>${lost.length ? `<h3 style="margin-top:12px" class="mute">Traded away</h3><div class="picks">${lost.join('')}</div>` : ''}</div>`;
}

/* ---------- Matchups ---------- */
function vMatchups(L) {
  const by = {};
  L.cur.forEach(m => { if (m.matchup_id) (by[m.matchup_id] = by[m.matchup_id] || []).push(m); });
  const side = (m, right, winning) => {
    const t = L.byRid[m.roster_id];
    const starters = (m.starters || []).filter(x => x && x !== '0');
    const left = starters.filter(id => !L.player(id).playedThisWk);
    const projLeft = left.reduce((a, id) => a + L.player(id).proj, 0);
    return { t, starters, left, projLeft, pts: m.points || 0, right, winning };
  };
  const cards = Object.values(by).map(pair => {
    pair.sort((a, b) => (L.me && a.roster_id === L.me.rid ? -1 : L.me && b.roster_id === L.me.rid ? 1 : 0));
    const [a, b] = pair; if (!b) return '';
    const A = side(a), B = side(b);
    const fa = A.pts + A.projLeft, fb = B.pts + B.projLeft;
    const pctA = fa + fb ? fa / (fa + fb) * 100 : 50;
    const sideHtml = (X, r) => `<div class="side ${r ? 'r' : ''} ${(r ? fb > fa : fa > fb) ? 'win' : ''}">${r ? `<div style="display:flex;justify-content:flex-end">${teamCell(X.t)}</div>` : teamCell(X.t)}<div class="sc">${f1(X.pts)}</div><div class="sub">${X.left.length} left · proj ${f1(X.pts + X.projLeft)}</div></div>`;
    const list = X => X.starters.map(id => { const p = L.player(id); const v = p.thisWk; return `<tr><td><span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></td><td>${esc(p.name)}${injTag(p)}</td><td class="n">${p.playedThisWk || v ? f1(v) : `<span class="mute">${f1(p.proj)}p</span>`}</td></tr>`; }).join('');
    const isMe = L.me && (a.roster_id === L.me.rid);
    return `<div class="card" ${isMe ? 'style="border-color:var(--accent)"' : ''}><div class="mu">${sideHtml(A, false)}<div class="vs">vs</div>${sideHtml(B, true)}</div>
      <div class="bar"><i style="width:${pctA.toFixed(1)}%"></i><b style="width:${(100 - pctA).toFixed(1)}%"></b></div>
      <details><summary>Starters</summary><div class="grid g2" style="margin-top:8px"><div class="tw"><table>${list(A)}</table></div><div class="tw"><table>${list(B)}</table></div></div></details></div>`;
  }).join('');
  return `<div class="hint">Week ${L.curWeek}. Grey numbers ending in “p” are projections for players who haven't played yet; projected final = current score + remaining projections.${L.sport === 'nba' ? ' NBA projections are per period and approximate.' : ''}</div><div class="grid g2">${cards || '<div class="card">No matchups this week.</div>'}</div>`;
}

/* ---------- Teams ---------- */
function needs(L, t) {
  // compare each of the team's lineup slots with the league median for that slot
  const opts = L.teams.map(x => optimal(L, activePids(L, x)));
  const mine = optimal(L, activePids(L, t));
  return L.slots.map((s, i) => {
    const vals = opts.map(o => o.lineup[i] && o.lineup[i].p ? o.lineup[i].p.ppg : 0).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const cur = mine.lineup[i] && mine.lineup[i].p;
    return { slot: s, i, p: cur, ppg: cur ? cur.ppg : 0, diff: (cur ? cur.ppg : 0) - med };
  });
}
function vTeams(L) {
  const sel = S.ui.teamRid || (L.me ? L.me.rid : L.teams[0].rid);
  const t = L.byRid[sel] || L.teams[0];
  const n = needs(L, t).filter(x => !['K', 'DEF'].includes(x.slot)).sort((a, b) => a.diff - b.diff);
  const chips = n.slice(0, 4).map(x => `<span class="chip ${x.diff < -1 ? 'bad' : ''}">${esc(x.slot)}: ${x.p ? esc(x.p.name) : 'empty'} <b class="${x.diff < 0 ? 'bad' : 'good'}">${x.diff >= 0 ? '+' : ''}${f1(x.diff)}</b></span>`).join('');
  return `<div class="controls"><label>Team</label><select id="teamSel">${L.standings.map(x => `<option value="${x.rid}" ${x.rid === t.rid ? 'selected' : ''}>${x.rank}. ${esc(x.name)} (${rec(x)})</option>`).join('')}</select></div>
    <div class="card"><h2>${esc(t.name)} <span class="sub">${esc(t.owner)} · ${rec(t)} · Max PF ${f1(t.maxpf)}</span></h2>
    <div class="sub">Weakest lineup spots vs league median (pts/g):</div><div class="need">${chips}</div>
    ${rosterTable(L, t)}</div>${L.hasPicks ? picksCard(L, t) : ''}`;
}

/* ---------- Players ---------- */
function vPlayers(L) {
  const mode = S.ui.pmode || 'fa';
  const pos = S.ui.ppos || 'ALL';
  const q = (S.ui.pq || '').toLowerCase();
  const minGp = L.sport === 'nfl' ? 2 : 1;
  const posList = L.sport === 'nfl' ? ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'] : ['ALL', 'PG', 'SG', 'SF', 'PF', 'C'];
  let ids = Object.keys(L.stats);
  if (mode === 'fa') ids = ids.filter(id => !L.owner[id]);
  else if (mode === 'rostered') ids = ids.filter(id => L.owner[id]);
  let ps = ids.map(L.player).filter(p => p.gp >= minGp && p.pos !== '?' && (pos === 'ALL' || p.positions.includes(pos)) && (!q || p.name.toLowerCase().includes(q)));
  ps.sort((a, b) => b.ppg - a.ppg); ps = ps.slice(0, 75);
  const rows = ps.map((p, i) => {
    const o = L.owner[p.id] ? L.byRid[L.owner[p.id]] : null;
    return `<tr class="${L.me && o && o.rid === L.me.rid ? 'me' : ''}"><td class="n">${i + 1}</td><td><span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></td><td>${plCell(L, p)}</td><td>${o ? esc(o.name) : '<span class="good">Free agent</span>'}</td><td class="n">${p.gp}</td><td class="n">${f1(p.total)}</td><td class="n"><b>${f1(p.ppg)}</b></td><td class="n">${f1(p.lastWk)}</td></tr>`;
  }).join('');
  return `<div class="controls"><div class="seg" id="pmodeSeg">
      <button data-pmode="fa" class="${mode === 'fa' ? 'on' : ''}">Free agents</button>
      <button data-pmode="rostered" class="${mode === 'rostered' ? 'on' : ''}">Rostered</button>
      <button data-pmode="all" class="${mode === 'all' ? 'on' : ''}">All</button></div>
      <select id="pposSel">${posList.map(x => `<option ${x === pos ? 'selected' : ''}>${x}</option>`).join('')}</select>
      <input type="search" id="pq" placeholder="Search player" value="${esc(S.ui.pq || '')}"></div>
    <div class="card"><h2>Top performers by points per game</h2><div class="hint">Season to date, this league's scoring, minimum ${minGp} game${minGp > 1 ? 's' : ''}. Top 75 shown.</div>
    <div class="tw"><table><thead><tr><th class="n">#</th><th>Pos</th><th>Player</th><th>Fantasy team</th><th class="n">GP</th><th class="n">Total</th><th class="n">PPG</th><th class="n">Last wk</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="mute">No players match.</td></tr>'}</tbody></table></div></div>`;
}

/* ---------------- events ---------------- */
function bind() {
  const L = S.L;
  document.querySelectorAll('[data-rule]').forEach(b => b.onclick = () => { store.set(b.parentElement.dataset.ruleKey, b.dataset.rule); render(); });
  document.querySelectorAll('[data-rsort]').forEach(b => b.onclick = () => { S.ui.rsort = b.dataset.rsort; render(); });
  document.querySelectorAll('[data-keep]').forEach(c => c.onchange = () => {
    const k = 'sd_keep_' + L.league.league_id; const set = new Set(store.get(k, []));
    c.checked ? set.add(c.dataset.keep) : set.delete(c.dataset.keep); store.set(k, [...set]); render();
  });
  document.querySelectorAll('[data-keeprule]').forEach(b => b.onclick = () => { store.set('sd_keeprule_' + L.league.league_id, b.dataset.keeprule); loadLeague(L.league.league_id); });
  const ts = $('#teamSel'); if (ts) ts.onchange = () => { S.ui.teamRid = +ts.value; render(); };
  document.querySelectorAll('[data-target]').forEach(b => b.onclick = () => { S.ui.target = b.dataset.target; render(); });
  document.querySelectorAll('[data-pmode]').forEach(b => b.onclick = () => { S.ui.pmode = b.dataset.pmode; render(); });
  const pp = $('#pposSel'); if (pp) pp.onchange = () => { S.ui.ppos = pp.value; render(); };
  if (typeof bindModules === 'function') bindModules();
  if (typeof bindExtra === 'function') bindExtra();
  const pq = $('#pq'); if (pq) pq.oninput = debounce(() => { S.ui.pq = pq.value; render(); const n = $('#pq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

init();
