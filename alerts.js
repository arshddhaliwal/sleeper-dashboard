'use strict';
/* Lineup alerts: injured / bye / empty starters, better bench options, IR moves, trending drops, hot waiver adds. */

const SEV = { crit: { label: 'Fix now', cls: 'crit' }, warn: { label: 'Check', cls: 'warn' }, opp: { label: 'Opportunity', cls: 'opp' }, info: { label: 'FYI', cls: 'info' } };
const SEV_ORDER = { crit: 0, warn: 1, opp: 2, info: 3 };

function kickoff(p) {
  if (!p.game || !p.game.date) return '';
  try { return new Date(p.game.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }); } catch { return ''; }
}

function computeAlerts(L) {
  const out = [];
  const t = L.me; if (!t) return out;
  const lg = L.league.name.trim();
  const add = (sev, title, detail, pid) => out.push({ sev, title, detail, league: lg, leagueId: L.league.league_id, pid });
  const startersRaw = (L.league.roster_positions || []).filter(s => !NON_LINEUP.has(s));
  const rosterStarters = t.slotsRaw && t.slotsRaw.length ? t.slotsRaw : t.starters;
  // 1) empty starting slots
  const emptySlots = startersRaw.filter((slot, i) => !rosterStarters[i] || rosterStarters[i] === '0');
  if (emptySlots.length) add('crit', `${emptySlots.length} empty starting spot${emptySlots.length > 1 ? 's' : ''}: ${emptySlots.join(', ')}`, 'You’re giving away free points — fill every slot before games lock.');
  const starters = (rosterStarters || []).filter(x => x && x !== '0').map(L.player);
  // 2) injured / bye starters that can still be changed
  for (const p of starters) {
    if (p.locked) continue;
    if (p.bye) add('crit', `${p.name} is on bye`, `Starting at ${p.pos} for ${p.team}, who don’t play in week ${L.curWeek}.`, p.id);
    else if (OUT.has(p.inj)) add('crit', `${p.name} is ${p.inj}`, `${p.body ? p.body + ' · ' : ''}Still in your starting lineup.`, p.id);
    else if (p.inj === 'Doubtful') add('crit', `${p.name} is Doubtful`, `${p.body ? p.body + ' · ' : ''}Very unlikely to play — swap him out.`, p.id);
    else if (p.inj === 'Questionable') add('warn', `${p.name} is Questionable`, `${p.body ? p.body + ' · ' : ''}${p.practice ? 'Practice: ' + p.practice + ' · ' : ''}Check status before ${kickoff(p) || 'kickoff'}; have a backup ready.`, p.id);
  }
  // 3) better bench option by this week's projection (NFL)
  if (L.sport === 'nfl') {
    const bench = t.players.filter(id => !rosterStarters.includes(id) && !t.reserve.has(id) && !t.taxi.has(id)).map(L.player)
      .filter(p => !p.locked && !p.bye && !OUT.has(p.inj) && p.proj > 0);
    const used = new Set();
    (rosterStarters || []).forEach((sid, i) => {
      const slot = startersRaw[i]; if (!slot) return;
      const s = sid && sid !== '0' ? L.player(sid) : null;
      if (s && s.locked) return;
      const el = eligible(slot);
      const sProj = s && !s.bye && !OUT.has(s.inj) ? s.proj : 0;
      let best = null;
      for (const b of bench) if (!used.has(b.id) && b.positions.some(x => el.includes(x)) && b.proj - sProj >= 2.5 && (!best || b.proj > best.proj)) best = b;
      if (best && s && !s.bye && !OUT.has(s.inj)) { used.add(best.id); add('warn', `Start ${best.name} over ${s.name}?`, `${slot}: projected ${f1(best.proj)} vs ${f1(sProj)} (+${f1(best.proj - sProj)}).`, best.id); }
    });
  }
  // 4) reserve slot housekeeping
  const resSlots = L.league.settings.reserve_slots || 0;
  for (const id of t.reserve) { const p = L.player(id); if (!p.inj) add('warn', `${p.name} is healthy but on IR`, 'Move him back to your active roster (Sleeper can block other moves until you do).', id); }
  if (resSlots > t.reserve.size) {
    const irable = t.players.filter(id => !t.reserve.has(id) && !t.taxi.has(id)).map(L.player).filter(p => p.inj === 'IR' || (p.inj === 'Out' && L.league.settings.reserve_allow_out));
    irable.slice(0, 3).forEach(p => add('info', `Open IR spot: stash ${p.name}`, `${p.inj}${p.body ? ' · ' + p.body : ''} — moving him to IR frees a roster spot.`, p.id));
  }
  // 5) market signals
  t.players.map(id => ({ id, r: L.dropRank[id] })).filter(x => x.r && x.r.rank <= 15).sort((a, b) => a.r.rank - b.r.rank).slice(0, 3)
    .forEach(({ id, r }) => { const p = L.player(id); add('info', `${p.name} is being dropped across Sleeper`, `#${r.rank} most-dropped in the last 24h (${r.count.toLocaleString()} drops). Worth a look at his role.`, id); });
  const fas = L.trendAdd.filter(x => !L.owner[x.player_id]).slice(0, 3).map(x => ({ p: L.player(x.player_id), x })).filter(o => o.p.pos !== '?');
  fas.forEach(({ p, x }) => add('opp', `${p.name} is available`, `${p.pos} · ${p.team || 'FA'} — #${L.addRank[x.player_id].rank} most-added player on Sleeper today, and a free agent in this league.`, p.id));
  return out.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
}

async function loadAllAlerts() {
  const user = S.user; if (!user) return;
  try {
    const results = await Promise.all(S.leagues.map(async league => {
      const sport = league.sport, st = S.states[sport] || {};
      const season = league.season;
      const curWeek = Math.max(1, (st.season === season ? (st.display_week || st.week) : 0) || 1);
      const [rosters, mus, extra] = await Promise.all([
        j(`${API}/league/${league.league_id}/rosters`, []),
        j(`${API}/league/${league.league_id}/matchups/${curWeek}`, []),
        sportData(sport, season, curWeek)
      ]);
      const L = build({ league, users: [], rosters, traded: [], mus: [mus], weeks: [curWeek], curWeek, sport, values: null, ...extra });
      return computeAlerts(L).map(a => ({ ...a, sport }));
    }));
    if (S.user !== user) return;
    S.allAlerts = results.flat();
  } catch (e) { S.allAlerts = []; }
  markTab();
  if (S.tab === 'alerts' || S.tab === 'overview') render();
}

function alertItem(a, showLeague) {
  const s = SEV[a.sev];
  return `<div class="alert ${s.cls}"><span class="sev">${s.label}</span><div><div class="at">${esc(a.title)}</div><div class="sub">${showLeague ? `<b>${esc(a.league)}</b> · ` : ''}${esc(a.detail)}</div></div></div>`;
}
function alertStrip(L) {
  const list = computeAlerts(L).filter(a => a.sev === 'crit' || a.sev === 'warn');
  if (!list.length) return L.me ? `<div class="alert ok"><span class="sev">All set</span><div><div class="at">No lineup problems this week</div><div class="sub">No injured, bye-week or empty starters that can still be changed.</div></div></div>` : '';
  return `<div class="alerts">${list.slice(0, 3).map(a => alertItem(a, false)).join('')}${list.length > 3 ? `<button class="linkbtn" data-goto="alerts">See all ${list.length} alerts →</button>` : ''}</div>`;
}
function vAlerts(L) {
  const all = S.allAlerts;
  const head = `<div class="hint">Checks every league you're in: injured, doubtful or bye-week starters, empty slots, better bench options by this week's projection, IR housekeeping, players being dropped across Sleeper, and hot free agents. Players whose games have already started are skipped since they're locked.</div>`;
  if (!all) return head + '<div class="loading">Checking all your leagues…</div>';
  if (!all.length) return head + '<div class="alert ok"><span class="sev">All set</span><div><div class="at">Nothing to fix in any league</div></div></div>';
  const byLeague = {};
  all.forEach(a => (byLeague[a.leagueId] = byLeague[a.leagueId] || []).push(a));
  const ids = Object.keys(byLeague).sort((a, b) => (a === L.league.league_id ? -1 : b === L.league.league_id ? 1 : 0));
  const counts = Object.fromEntries(Object.keys(SEV).map(k => [k, all.filter(a => a.sev === k).length]));
  return head + `<div class="kpis">${Object.entries(SEV).map(([k, v]) => `<div class="kpi"><div class="l">${v.label}</div><div class="v sev-${k}">${counts[k]}</div></div>`).join('')}</div>
    <div class="grid g2">${ids.map(id => { const lst = byLeague[id]; const lgObj = S.leagues.find(l => l.league_id === id);
      return `<div class="card"><h2 style="display:flex;justify-content:space-between;gap:8px">${esc(lst[0].league)} <span class="badge ${lgObj ? leagueKind(lgObj) : ''}">${lst[0].sport.toUpperCase()}</span></h2>${lst.map(a => alertItem(a, false)).join('')}</div>`; }).join('')}</div>`;
}
