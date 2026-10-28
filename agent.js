'use strict';
/* GM Agent tab: an autonomous Claude agent. You pick a goal; it plans, calls the app's own tools (the same trade
   engine, strategy model, league history and lineup checks the other tabs use), verifies every trade it proposes,
   and returns a structured plan. Then you can ask follow-up questions. The model runs on /api/agent; every tool
   runs here in the browser against the loaded league. */

const GM_MAX_ROUNDS = 14, CHAT_MAX_ROUNDS = 6;

const plain = s => { const d = document.createElement('div'); d.innerHTML = String(s == null ? '' : s).replace(/<[^>]+>/g, ' '); return d.textContent.replace(/\s+/g, ' ').trim(); };
const r1 = n => n == null || isNaN(n) ? null : Math.round(n * 10) / 10;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function gmGoals(L) {
  return L.kind === 'redraft'
    ? [{ key: 'auto', label: 'Let the agent decide', sub: 'It reads the standings and picks win-now or a playoff push' }, { key: 'week', label: 'Win this week', sub: 'Lineup, waivers and quick upgrades' }, { key: 'playoffs', label: 'Playoff push', sub: 'Trades that raise your weekly ceiling for the rest of the season' }]
    : [{ key: 'auto', label: 'Let the agent decide', sub: 'It weighs standings, roster value, luck and age' }, { key: 'win', label: 'Win now', sub: 'Turn depth and future picks into starters' }, { key: 'retool', label: 'Retool for next year', sub: 'Sell aging pieces, consolidate into younger starters' }, { key: 'rebuild', label: 'Full rebuild', sub: 'Sell veterans for picks and young players' }];
}

/* ---------- lookups ---------- */
function findTeam(L, q) {
  const n = norm(String(q || '').replace(/\(user\)/i, ''));
  if (!n || ['me', 'my team', 'mine', 'my', 'i', 'user', 'you'].includes(n)) return L.me || null;
  return L.teams.find(t => norm(t.name) === n) || L.teams.find(t => norm(t.owner) === n)
    || L.teams.find(t => norm(t.name).includes(n) || n.includes(norm(t.name))) || L.teams.find(t => norm(t.owner).includes(n)) || null;
}
function findPlayerId(L, q) {
  const n = norm(q); if (!n) return null;
  let best = null, bestScore = 0;
  for (const id of new Set([...Object.keys(L.owner), ...Object.keys(L.stats)])) {
    const p = L.player(id); if (p.pos === '?') continue;
    const pn = norm(p.name);
    let s = pn === n ? 100 : pn.startsWith(n) ? 80 : pn.includes(n) ? 60 : n.split(' ').every(w => pn.includes(w)) ? 50 : (pn.split(' ').pop() === n.split(' ').pop() ? 35 : 0);
    if (!s) continue;
    s += (L.owner[id] ? 5 : 0) + Math.min(5, (p.ppg || 0) / 4);
    if (s > bestScore) { best = id; bestScore = s; }
  }
  return best;
}
const teamRef = (L, t) => t ? `${t.name}${L.me && t.rid === L.me.rid ? ' (user)' : ''}` : null;
const pickName = (L, pk, holder) => `${pk.y} ${ORD(pk.r)}${pk.orig !== holder ? ` (from ${L.byRid[pk.orig] ? L.byRid[pk.orig].name : 'team ' + pk.orig})` : ''}`;
function playerRow(L, p, t) {
  const role = t ? (t.reserve.has(p.id) ? 'IR' : t.taxi.has(p.id) ? 'taxi' : t.starters.includes(p.id) ? 'starter' : 'bench') : undefined;
  const o = { name: p.name, pos: p.pos, nfl_team: p.team || 'FA', age: p.age || null, ppg: r1(p.ppg), games: p.gp, value: Math.round(valueModel(L).playerVal(p)) || 0 };
  if (p.inj) o.injury = p.inj;
  if (role) o.role = role;
  if (p.proj) o.proj_this_week = r1(p.proj);
  return o;
}
// Resolve names like "Tee Higgins" or "2027 1st (Team X)" to trade items on one team's roster.
function resolveItems(L, team, names) {
  const items = itemsFor(L, team), got = [], missing = [];
  const RN = { '1st': 1, first: 1, '1': 1, '2nd': 2, second: 2, '2': 2, '3rd': 3, third: 3, '3': 3, '4th': 4, fourth: 4, '4': 4, '5th': 5, fifth: 5, '5': 5 };
  for (const raw of names || []) {
    const n = norm(raw);
    const pm = n.match(/(20\d\d) ?(1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|[1-5])\b/);
    let it = null;
    if (pm) {
      const cands = items.filter(i => i.kind === 'k' && i.pk.y === pm[1] && i.pk.r === RN[pm[2]] && !got.includes(i));
      it = cands.find(i => L.byRid[i.pk.orig] && i.pk.orig !== team.rid && n.includes(norm(L.byRid[i.pk.orig].name))) || cands.find(i => i.pk.orig === team.rid) || cands[0];
    } else {
      const id = findPlayerId(L, raw);
      it = items.find(i => i.kind === 'p' && i.id === id) || items.find(i => i.kind === 'p' && norm(i.name).includes(n));
    }
    if (it && !got.includes(it)) got.push(it); else if (!it) missing.push(raw);
  }
  return { got, missing };
}
function checkTrade(L, from, other, give, get) {
  const g = resolveItems(L, from, give), r = resolveItems(L, other, get);
  if (g.missing.length || r.missing.length) return { error: `Not on the right roster: ${[...g.missing.map(x => `${x} (not on ${from.name})`), ...r.missing.map(x => `${x} (not on ${other.name})`)].join(', ')}` };
  if (!g.got.length || !r.got.length) return { error: 'Both sides need at least one player or pick.' };
  const ev = evalTrade(L, from, other, g.got, r.got), acc = acceptance(L, other, ev);
  const grade = ev.pct >= 0.15 ? 'A' : ev.pct >= 0.05 ? 'B+' : ev.pct >= -0.05 ? 'B' : ev.pct >= -0.15 ? 'C' : 'D';
  return { g: g.got, r: r.got, ev, acc, grade };
}

/* ---------- tools (run in the browser) ---------- */
const AGENT_TOOLS = {
  get_league_overview(L) {
    const prof = leagueProfiles(L), pr = rid => prof.find(x => x.t.rid === rid);
    return {
      league: L.league.name.trim(), sport: L.sport, type: L.kind, season: L.league.season, week: L.curWeek, teams: L.teams.length, playoff_teams: L.league.settings.playoff_teams || null,
      scoring: L.sport === 'nfl' ? (L.scoring.rec === 1 ? 'PPR' : L.scoring.rec === 0.5 ? 'Half-PPR' : 'Standard') : 'points',
      carry_over: L.keepRule === 'all' ? 'whole roster (dynasty)' : L.keepRule === 'limited' ? `${L.maxKeepers} keepers` : 'none (redraft)',
      future_picks_tradeable: L.hasPicks, value_source: valueModel(L).market ? 'FantasyCalc market values' : 'scoring-based values', user_team: L.me ? L.me.name : null,
      standings: L.standings.map(t => ({ rank: t.rank, team: teamRef(L, t), manager: t.owner, record: rec(t), points_for: r1(t.pf), max_points: r1(t.maxpf), verdict: pr(t.rid).verdict.label, roster_value_rank: pr(t.rid).totalRank }))
    };
  },
  scan_league_needs(L) {
    const prof = leagueProfiles(L);
    return { teams: L.standings.map(t => {
      const nd = needs(L, t).filter(x => !['K', 'DEF'].includes(x.slot));
      const x = prof.find(p => p.t.rid === t.rid);
      return { team: teamRef(L, t), record: rec(t), mode: MODE_LABEL[teamMode(L, t)], verdict: x.verdict.label, roster_value_rank: x.totalRank, pick_value_rank: L.hasPicks ? x.pickValRank : undefined,
        weakest: nd.slice().sort((a, b) => a.diff - b.diff).slice(0, 2).map(y => `${y.slot} (${y.p ? y.p.name : 'empty'}, ${r1(y.diff)} ppg vs median)`),
        strongest: nd.slice().sort((a, b) => b.diff - a.diff).slice(0, 2).map(y => `${y.slot} (${y.p ? y.p.name : '-'}, +${r1(y.diff)})`) };
    }) };
  },
  get_team_roster(L, a) {
    const t = findTeam(L, a.team); if (!t) return { error: `No team matching "${a.team}". Teams: ${L.teams.map(x => x.name).join(', ')}` };
    const vm = valueModel(L);
    return { team: teamRef(L, t), manager: t.owner, record: rec(t), rank: t.rank, mode: MODE_LABEL[teamMode(L, t)],
      players: t.players.map(L.player).map(p => playerRow(L, p, t)).sort((x, y) => y.value - x.value || y.ppg - x.ppg),
      picks: L.hasPicks ? (L.picks.byOwner[t.rid] || []).map(pk => { const k = { ...pk }; return { pick: pickName(L, k, t.rid), value: Math.round(vm.pickVal(k)) || 0 }; }) : [] };
  },
  get_team_strategy(L, a) {
    const t = findTeam(L, a.team); if (!t) return { error: `No team matching "${a.team}".` };
    const x = leagueProfiles(L).find(p => p.t.rid === t.rid), N = L.teams.length;
    return { team: teamRef(L, t), record: rec(t), rank: t.rank, verdict: x.verdict.label, advice: VERDICT_TEXT[x.verdict.key],
      roster_value_rank: `${x.totalRank} of ${N}`, player_value_rank: `${x.playerValRank} of ${N}`, pick_capital_rank: L.hasPicks ? `${x.pickValRank} of ${N}` : 'no future picks (redraft)',
      core_age: r1(x.coreAge), core_age_rank_youngest_first: `${x.coreAgeRank} of ${N}`,
      all_play_win_pct: x.apPct == null ? null : Math.round(x.apPct * 100), luck_wins: r1(x.luck),
      position_rank: Object.fromEntries(posGroups(L).map(pos => [pos, `${x['posRank_' + pos]} of ${N}`])),
      top_assets: x.ps.slice(0, 6).map(y => ({ name: y.p.name, pos: y.p.pos, age: y.p.age, value: Math.round(y.v) })),
      aging_risks: x.ps.filter(y => y.p.age && CLIFF[L.sport] && CLIFF[L.sport][y.p.pos] && y.p.age >= CLIFF[L.sport][y.p.pos] - 1 && y.v > 0).slice(0, 5).map(y => `${y.p.name} (${y.p.pos}, ${y.p.age})`) };
  },
  find_players(L, a) {
    const n = norm(a.name), pos = String(a.position || '').toUpperCase(), lim = Math.min(25, Math.max(1, +a.limit || 10));
    let ids = [...new Set([...Object.keys(L.stats), ...Object.keys(L.owner)])];
    if (a.free_agents_only) ids = ids.filter(id => !L.owner[id]);
    const ps = ids.map(L.player).filter(p => p.pos !== '?' && (!pos || p.positions.includes(pos)) && (!n || norm(p.name).includes(n)) && (n || p.gp >= 1)).sort((x, y) => (y.ppg || 0) - (x.ppg || 0));
    return { results: ps.slice(0, lim).map(p => ({ ...playerRow(L, p), fantasy_team: L.owner[p.id] ? teamRef(L, L.byRid[L.owner[p.id]]) : 'free agent' })) };
  },
  suggest_trades(L, a) {
    if (!L.me) return { error: 'The user has no team in this league.' };
    const keep = new Set(L.usesKeepers ? store.get('sd_keep_' + L.league.league_id, []) : []);
    let targets = L.standings.filter(t => t.rid !== L.me.rid);
    if (a.with_team) { const t = findTeam(L, a.with_team); if (!t || t.rid === L.me.rid) return { error: `No other team matching "${a.with_team}".` }; targets = [t]; }
    const all = targets.flatMap(t => suggestFor(L, L.me, t, keep).map(o => ({ ...o, t }))).sort((x, y) => y.score - x.score).slice(0, Math.min(10, Math.max(1, +a.limit || 5)));
    return { user_mode: MODE_LABEL[teamMode(L, L.me)], trades: all.map(o => ({
      with_team: o.t.name, their_mode: MODE_LABEL[teamMode(L, o.t)],
      user_gives: o.g.map(i => i.kind === 'k' ? pickName(L, i.pk, L.me.rid) : i.name), user_gets: o.r.map(i => i.kind === 'k' ? pickName(L, i.pk, o.t.rid) : i.name),
      value_edge_for_user_pct: Math.round(o.ev.pct * 100), user_lineup_change_ppg: r1(o.ev.myLineup), their_lineup_change_ppg: r1(o.ev.thLineup),
      likely_accepted: o.acc.label, reasons: reasons(L, L.me, o.t, o.ev).map(plain) })),
      note: all.length ? undefined : 'No balanced trades found with these teams.' };
  },
  evaluate_trade(L, a) {
    const from = a.from_team ? findTeam(L, a.from_team) : L.me, other = findTeam(L, a.other_team);
    if (!from) return { error: 'Could not tell which team gives the first side.' };
    if (!other || other.rid === from.rid) return { error: `No other team matching "${a.other_team}".` };
    const c = checkTrade(L, from, other, a.give, a.get); if (c.error) return { error: c.error };
    return { from_team: teamRef(L, from), other_team: teamRef(L, other),
      gives: c.g.map(i => ({ item: i.kind === 'k' ? pickName(L, i.pk, from.rid) : i.name, value: Math.round(i.val) })),
      gets: c.r.map(i => ({ item: i.kind === 'k' ? pickName(L, i.pk, other.rid) : i.name, value: Math.round(i.val) })),
      package_value_given: Math.round(c.ev.vGive), package_value_received: Math.round(c.ev.vGet), edge_pct: Math.round(c.ev.pct * 100), grade: c.grade,
      from_lineup_change_ppg: r1(c.ev.myLineup), other_lineup_change_ppg: r1(c.ev.thLineup), other_team_mode: MODE_LABEL[teamMode(L, other)],
      would_other_team_accept: c.acc.label, reasons: reasons(L, from, other, c.ev).map(plain) };
  },
  shop_players(L, a) {
    if (!L.me) return { error: 'The user has no team in this league.' };
    const g = resolveItems(L, L.me, a.give);
    if (g.missing.length) return { error: `Not on the user's roster: ${g.missing.join(', ')}` };
    if (!g.got.length) return { error: 'Name at least one player or pick to shop.' };
    let targets = L.standings.filter(t => t.rid !== L.me.rid);
    if (a.with_team) { const t = findTeam(L, a.with_team); if (!t || t.rid === L.me.rid) return { error: `No other team matching "${a.with_team}".` }; targets = [t]; }
    const mm = teamMode(L, L.me), vg = pkgVal(g.got), out = [];
    for (const t of targets) {
      let get = itemsFor(L, t).filter(i => i.val > 0);
      get = [...get.filter(i => i.kind === 'p').sort((x, y) => y.val - x.val).slice(0, 12), ...get.filter(i => i.kind === 'k').sort((x, y) => y.val - x.val).slice(0, 4)];
      const combos = get.map(x => [x]);
      for (let i = 0; i < get.length; i++) for (let k = i + 1; k < get.length; k++) combos.push([get[i], get[k]]);
      for (let i = 0; i < Math.min(get.length, 8); i++) for (let k = i + 1; k < Math.min(get.length, 8); k++) for (let m = k + 1; m < Math.min(get.length, 8); m++) combos.push([get[i], get[k], get[m]]);
      const best = [];
      for (const r of combos) {
        const vr = pkgVal(r), pct = (vr - vg) / Math.max(vr, vg, 1);
        if (pct < -0.1 || pct > 0.25) continue;
        const ev = evalTrade(L, L.me, t, g.got, r), acc = acceptance(L, t, ev);
        if (!acc.ok) continue;
        // a team trying to win this year won't take a big lineup hit unless it's clearly winning on value
        if (teamMode(L, t) !== 'rebuilder' && ev.thLineup < -2 && -ev.pct < 0.15) continue;
        const score = pct * 100 + (mm === 'rebuilder' ? ev.picksIn * 5 : ev.myLineup * 4) + Math.min(3, ev.thLineup);
        best.push({ t, r, ev, acc, score });
      }
      best.sort((x, y) => y.score - x.score);
      out.push(...best.slice(0, 2));
    }
    out.sort((x, y) => y.score - x.score);
    const lim = Math.min(8, Math.max(1, +a.limit || 5));
    return { shopping: g.got.map(i => i.kind === 'k' ? pickName(L, i.pk, L.me.rid) : i.name), package_value: Math.round(vg), user_mode: MODE_LABEL[mm],
      offers: out.slice(0, lim).map(o => ({ partner: o.t.name, their_mode: MODE_LABEL[teamMode(L, o.t)], user_gets: o.r.map(i => i.kind === 'k' ? pickName(L, i.pk, o.t.rid) : i.name),
        value_edge_for_user_pct: Math.round(o.ev.pct * 100), user_lineup_change_ppg: r1(o.ev.myLineup), their_lineup_change_ppg: r1(o.ev.thLineup), likely_accepted: o.acc.label, reasons: reasons(L, L.me, o.t, o.ev).map(plain) })),
      note: out.length ? undefined : 'No team has a balanced package for exactly these players that they would likely accept. Try fewer players or a different combination.' };
  },
  async get_player_history(L, a) {
    const id = findPlayerId(L, a.player); if (!id) return { error: `No player matching "${a.player}".` };
    const H = await loadHistory(L) || await new Promise(res => { const iv = setInterval(() => { if (S.hist && S.hist.id === L.league.league_id) { clearInterval(iv); res(S.hist); } }, 300); setTimeout(() => { clearInterval(iv); res(null); }, 20000); });
    if (!H) return { error: 'League history is still loading. Try again shortly.' };
    const p = L.player(id), evs = H.events.filter(e => e.pid === id);
    return { player: p.name, pos: p.pos, now_on: L.owner[id] ? teamRef(L, L.byRid[L.owner[id]]) : 'free agent', seasons_covered: H.seasons,
      timeline: evs.map(e => ({ date: fmtDate(e.t), season: e.season, event: plain(eventLine(L, H, e)) })), note: evs.length ? undefined : 'No records in the seasons covered.' };
  },
  get_lineup_alerts(L) {
    if (!L.me) return { error: 'The user has no team in this league.' };
    return { alerts: computeAlerts(L).map(x => ({ severity: SEV[x.sev].label, title: x.title, detail: x.detail })) };
  },
  get_matchups(L) {
    const by = {}; L.cur.forEach(m => { if (m.matchup_id) (by[m.matchup_id] = by[m.matchup_id] || []).push(m); });
    const side = m => { const st = (m.starters || []).filter(x => x && x !== '0'), left = st.filter(id => !L.player(id).playedThisWk); return { team: teamRef(L, L.byRid[m.roster_id]), points: r1(m.points || 0), projected_final: r1((m.points || 0) + left.reduce((s, id) => s + L.player(id).proj, 0)), players_left: left.length }; };
    return { week: L.curWeek, matchups: Object.values(by).filter(p => p.length === 2).map(([x, y]) => [side(x), side(y)]) };
  }
};

// Plain-English trace line for each tool call
function traceLabel(L, c) {
  const a = c.args || {};
  switch (c.name) {
    case 'get_league_overview': return 'Read the standings and league settings';
    case 'scan_league_needs': return 'Scanned every team’s needs and strengths';
    case 'get_team_roster': return `Read ${findTeam(L, a.team) === L.me ? 'your' : esc(a.team) + '’s'} roster`;
    case 'get_team_strategy': return `Profiled ${findTeam(L, a.team) === L.me ? 'your team' : esc(a.team)}: value, age, luck`;
    case 'find_players': return a.free_agents_only ? `Searched free agents${a.position ? ' at ' + esc(a.position) : ''}` : `Looked up ${esc(a.name || a.position || 'players')}`;
    case 'suggest_trades': return a.with_team ? `Ran the trade engine against ${esc(a.with_team)}` : 'Ran the trade engine across the league';
    case 'evaluate_trade': return `Checked a trade: ${esc((a.give || []).join(' + '))} for ${esc((a.get || []).join(' + '))}`;
    case 'get_player_history': return `Traced ${esc(a.player)}’s history`;
    case 'shop_players': return `Shopped ${esc((a.give || []).join(' + '))} around the league`;
    case 'get_lineup_alerts': return 'Checked your lineup for problems';
    case 'get_matchups': return 'Read this week’s matchups';
    case 'submit_gm_plan': return 'Wrote the plan';
  }
  return esc(c.name);
}
function traceResult(c, res) {
  if (!res) return '';
  if (res.error) return `<span class="bad">${esc(res.error)}</span>`;
  switch (c.name) {
    case 'suggest_trades': return `${res.trades.length} candidate trade${res.trades.length === 1 ? '' : 's'}`;
    case 'shop_players': return `${res.offers.length} offer${res.offers.length === 1 ? '' : 's'}`;
    case 'evaluate_trade': return `${esc(res.grade)} · ${res.edge_pct >= 0 ? '+' : ''}${res.edge_pct}% value · ${esc(res.would_other_team_accept)}`;
    case 'get_team_strategy': return `${esc(res.verdict)} · value rank ${esc(res.roster_value_rank)}`;
    case 'find_players': return `${res.results.length} found`;
    case 'get_lineup_alerts': return `${res.alerts.length} alert${res.alerts.length === 1 ? '' : 's'}`;
    case 'get_league_overview': return `${esc(res.type)} · ${res.teams} teams · week ${res.week}`;
  }
  return '';
}

/* ---------- agent loop ---------- */
async function gmStatus() {
  if (S.gmStatus) return S.gmStatus;
  try { S.gmStatus = await (await fetch('/api/agent')).json(); } catch { S.gmStatus = { enabled: false }; }
  if (S.tab === 'gm') render();
  return S.gmStatus;
}
function gmState(L) {
  if (!S.gm || S.gm.league !== L.league.league_id) S.gm = { league: L.league.league_id, goal: 'auto', trace: [], plan: null, busy: false, chat: [], chatMsgs: [], usage: { turns: 0, tools: 0, in: 0, out: 0, cached: 0 } };
  return S.gm;
}
async function agentTurn(L, mode, msgs, st) {
  if (st.stop) throw new Error('Stopped.');
  const r = await fetch('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, messages: msgs, context: { league: L.league.name.trim(), sport: L.sport, kind: L.kind, week: L.curWeek, demo: !!S.demo } }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Server error ${r.status}`);
  st.usage.turns++;
  if (j.usage) { st.usage.in += j.usage.in || 0; st.usage.out += j.usage.out || 0; st.usage.cached += j.usage.cached || 0; }
  return j;
}
async function runTool(L, c) {
  try { return AGENT_TOOLS[c.name] ? await AGENT_TOOLS[c.name](L, c.args || {}) : { error: 'unknown tool' }; } catch (e) { return { error: String(e.message || e) }; }
}
function verifyPlan(L, plan) {
  (plan.trades || []).forEach(t => {
    const other = findTeam(L, t.partner);
    if (!L.me || !other || other.rid === L.me.rid) { t.check = { error: `Unknown partner "${t.partner}"` }; return; }
    const c = checkTrade(L, L.me, other, t.give, t.get);
    t.check = c.error ? { error: c.error } : { grade: c.grade, pct: c.ev.pct, acc: c.acc, my: c.ev.myLineup, th: c.ev.thLineup, rid: other.rid, give: c.g.map(i => i.id), get: c.r.map(i => i.id), gv: c.g, rv: c.r };
  });
  return plan;
}
async function gmRun(L) {
  const st = gmState(L);
  if (st.busy) return;
  const goal = gmGoals(L).find(g => g.key === st.goal) || gmGoals(L)[0];
  Object.assign(st, { busy: true, stop: false, trace: [], plan: null, error: null, chat: [], chatMsgs: [], usage: { turns: 0, tools: 0, in: 0, out: 0, cached: 0 } });
  const msgs = [{ role: 'user', text: `Goal: ${goal.label}${goal.key === 'auto' ? ' (choose the strategy yourself from the evidence)' : ''}. League type: ${L.kind}. Build my plan.` }];
  gmPaint();
  try {
    for (let round = 0; round < GM_MAX_ROUNDS && !st.plan; round++) {
      const j = await agentTurn(L, 'gm', msgs, st);
      if (j.text) st.trace.push({ kind: 'think', text: j.text });
      if (!j.calls || !j.calls.length) { if (round === GM_MAX_ROUNDS - 1 || !j.text) break; msgs.push({ role: 'assistant', text: j.text }); msgs.push({ role: 'user', text: 'Continue, and finish by calling submit_gm_plan.' }); gmPaint(); continue; }
      msgs.push({ role: 'assistant', text: j.text || '', calls: j.calls });
      const steps = j.calls.map(c => { const s = { kind: 'tool', c, label: traceLabel(L, c), res: null }; st.trace.push(s); return s; });
      gmPaint();
      for (const s of steps) {
        st.usage.tools++;
        if (s.c.name === 'submit_gm_plan') {
          st.plan = verifyPlan(L, JSON.parse(JSON.stringify(s.c.args || {})));
          s.res = { ok: true };
          msgs.push({ role: 'tool', id: s.c.id, name: s.c.name, result: JSON.stringify({ ok: true, verification: (st.plan.trades || []).map(t => t.check.error ? { partner: t.partner, error: t.check.error } : { partner: t.partner, grade: t.check.grade, accept: t.check.acc.label }) }) });
          continue;
        }
        s.res = await runTool(L, s.c);
        msgs.push({ role: 'tool', id: s.c.id, name: s.c.name, result: JSON.stringify(s.res) });
        gmPaint();
      }
    }
    if (!st.plan) throw new Error('The agent ran out of steps before finishing a plan. Try again or pick a narrower goal.');
    st.gmMsgs = msgs;
  } catch (e) { st.error = String(e.message || e); }
  st.busy = false;
  gmPaint();
}
async function gmChat(L, question) {
  const st = gmState(L);
  if (st.busy || !question.trim()) return;
  st.busy = true;
  const ctx = st.plan ? `Context (the GM plan you produced for me earlier):\n${JSON.stringify({ goal: st.plan.goal, verdict: st.plan.verdict, reasoning: st.plan.reasoning, trades: (st.plan.trades || []).map(t => ({ partner: t.partner, give: t.give, get: t.get, verified: t.check && !t.check.error ? `${t.check.grade}, ${t.check.acc.label}` : 'not verified' })), waiver_adds: st.plan.waiver_adds, lineup_fixes: st.plan.lineup_fixes })}\n\n` : '';
  // question first, plan context after, so the question can never be cut off by the server's length limit
  st.chatMsgs.push({ role: 'user', text: question.trim() + (st.chatMsgs.length || !ctx ? '' : `\n\n---\n${ctx}`) });
  const turn = { q: question.trim(), a: '', tools: [] }; st.chat.push(turn);
  gmPaint();
  try {
    for (let round = 0; round < CHAT_MAX_ROUNDS; round++) {
      const j = await agentTurn(L, 'chat', st.chatMsgs, st);
      if (j.calls && j.calls.length) {
        st.chatMsgs.push({ role: 'assistant', text: j.text || '', calls: j.calls });
        for (const c of j.calls) { turn.tools.push(c.name); gmPaint(); st.chatMsgs.push({ role: 'tool', id: c.id, name: c.name, result: JSON.stringify(await runTool(L, c)) }); }
        continue;
      }
      turn.a = j.text || '(no answer)'; st.chatMsgs.push({ role: 'assistant', text: turn.a }); break;
    }
    if (!turn.a) { turn.a = 'I ran out of steps. Try a narrower question.'; st.chatMsgs.push({ role: 'assistant', text: turn.a }); }
  } catch (e) {
    turn.err = String(e.message || e);
    while (st.chatMsgs.length && st.chatMsgs[st.chatMsgs.length - 1].role !== 'user') st.chatMsgs.pop();
    st.chatMsgs.pop();
  }
  st.busy = false;
  gmPaint();
}

/* ---------- view ---------- */
function mdLite(s) {
  let html = '', inList = false;
  for (const ln of esc(s).split('\n')) {
    const b = ln.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const m = b.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${m[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const t = b.replace(/^#+\s*/, '').trim(); if (t) html += `<p>${t}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}
const TOOL_SHORT = { get_league_overview: 'standings', scan_league_needs: 'league needs', get_team_roster: 'roster', get_team_strategy: 'strategy', find_players: 'player search', suggest_trades: 'trade engine', evaluate_trade: 'trade check', shop_players: 'shop players', get_player_history: 'history', get_lineup_alerts: 'lineup', get_matchups: 'matchups' };
function traceHtml(st) {
  if (!st.trace.length && !st.busy) return '';
  const items = st.trace.map(s => s.kind === 'think'
    ? `<li class="tthink">${esc(s.text)}</li>`
    : `<li class="${s.res ? 'tdone' : 'trun'}"><span class="tl">${s.label}</span>${s.res ? `<span class="tr">${traceResult(s.c, s.res)}</span>` : '<span class="tr mute">working…</span>'}</li>`).join('');
  return `<details class="trace" ${st.busy || !st.plan ? 'open' : ''}><summary>${st.busy ? '<span class="pulse"></span> Agent working' : 'Agent trace'} · ${st.usage.tools} tool call${st.usage.tools === 1 ? '' : 's'} · ${st.usage.turns} model turn${st.usage.turns === 1 ? '' : 's'}</summary><ol class="tlist2">${items}</ol></details>`;
}
function planHtml(L, st) {
  const p = st.plan; if (!p) return '';
  const chip = i => i.kind === 'k' ? `${esc(i.pk.y)} ${ORD(i.pk.r)}` : esc(i.name);
  const trades = (p.trades || []).map((t, i) => {
    const c = t.check || {};
    const badge = c.error ? `<span class="tag q">Couldn’t verify</span>` : `<span class="tag ${c.acc.cls === 'good' ? 'st' : 'q'}">${esc(c.grade)} · ${esc(c.acc.label)}</span>`;
    return `<div class="gmtrade"><div class="gmtrade-h"><span class="rk">${i + 1}</span><b>With ${esc(t.partner)}</b>${badge}</div>
      <div class="gmsides"><div><div class="sub">You give</div>${c.gv ? c.gv.map(chip).join(' + ') : esc((t.give || []).join(' + '))}</div><div class="arrow">→</div><div><div class="sub">You get</div><b>${c.rv ? c.rv.map(chip).join(' + ') : esc((t.get || []).join(' + '))}</b></div></div>
      ${c.error ? `<div class="sub bad">Verification: ${esc(c.error)}</div>` : `<div class="sub">Checked by the app: ${c.pct >= 0 ? '+' : ''}${Math.round(c.pct * 100)}% value · your lineup ${c.my >= 0 ? '+' : ''}${f1(c.my)}/g · theirs ${c.th >= 0 ? '+' : ''}${f1(c.th)}/g</div>`}
      <p>${esc(t.why || '')}</p>
      ${t.pitch ? `<div class="pitch"><span class="sub">Message to send</span><div>“${esc(t.pitch)}”</div></div>` : ''}
      ${c.error ? '' : `<button class="linkbtn" data-gmcalc="${i}">Open in Trade Calculator →</button>`}</div>`;
  }).join('');
  const list = (title, arr, fmt) => arr && arr.length ? `<div class="gmsec"><h3>${title}</h3><ul>${arr.map(x => `<li>${fmt(x)}</li>`).join('')}</ul></div>` : '';
  return `<div class="gmplan">
    <div class="gmhead"><span class="badge dynasty">${esc(p.goal || '')}</span><div class="gmverdict">${esc(p.verdict || '')}</div><p class="sub">${esc(p.reasoning || '')}</p></div>
    ${trades ? `<div class="gmsec"><h3>Trades</h3>${trades}</div>` : ''}
    ${list('Waiver moves', p.waiver_adds, w => `<b>Add ${esc(w.add)}</b>${w.drop ? ` · drop ${esc(w.drop)}` : ''} — ${esc(w.why || '')}`)}
    ${list('Lineup fixes', p.lineup_fixes, x => esc(x))}
    ${list('Watch list', p.watch_list, x => esc(x))}
  </div>`;
}
function chatHtml(st) {
  return st.chat.map(t => `<div class="msg me">${esc(t.q)}</div><div class="msg bot">${t.tools.length ? `<div class="toolrow">${[...new Set(t.tools)].map(x => `<span class="toolchip">↳ ${esc(TOOL_SHORT[x] || x)}</span>`).join('')}</div>` : ''}${t.err ? `<div class="bad">${esc(t.err)}</div>` : t.a ? mdLite(t.a) : '<div class="typing"><i></i><i></i><i></i></div>'}</div>`).join('');
}
function gmBodyHtml(L, st) {
  return `${st.error ? `<div class="alert crit"><span class="sev">Error</span><div><div class="at">${esc(st.error)}</div></div></div>` : ''}
    ${traceHtml(st)}${planHtml(L, st)}
    ${st.plan ? `<div class="card askcard"><h3 style="margin:0">Ask the agent about this plan</h3><div class="asklog" id="gmChatLog">${chatHtml(st) || '<div class="askempty">e.g. “What if they say no to trade 1?” or “Is there a better deal for a WR?”</div>'}</div>
      <form id="gmChatForm" class="askform"><input id="gmChatInput" maxlength="500" placeholder="Ask a follow-up…" autocomplete="off"><button type="submit" ${st.busy ? 'disabled' : ''}>Ask</button></form></div>` : ''}`;
}
function gmPaint() {
  const box = $('#gmBody'); if (!box || !S.gm || !S.L) { if (S.tab === 'gm') render(); return; }
  const keepOpen = box.querySelector('details.trace') && box.querySelector('details.trace').open;
  box.innerHTML = gmBodyHtml(S.L, S.gm);
  if (keepOpen && !S.gm.plan) { const d = box.querySelector('details.trace'); if (d) d.open = true; }
  const run = $('#gmRun'); if (run) { run.disabled = S.gm.busy; run.textContent = S.gm.busy ? 'Working…' : S.gm.plan ? 'Run again' : 'Run GM agent'; }
  const stop = $('#gmStop'); if (stop) stop.style.display = S.gm.busy ? '' : 'none';
  const log = $('#gmChatLog'); if (log) log.scrollTop = log.scrollHeight;
  bindGmBody();
}
function vGm(L) {
  const status = S.gmStatus; if (!status) gmStatus();
  const st = gmState(L), off = status && !status.enabled;
  if (!L.me) return `${leagueMeta(L)}<div class="card">The GM agent needs a team of yours in this league.</div>`;
  const goals = gmGoals(L); if (!goals.find(g => g.key === st.goal)) st.goal = 'auto';
  return `${leagueMeta(L)}
    <div class="card gmcard">
      <div class="askhead"><h2>GM Agent</h2><span class="sub">An autonomous Claude agent that plans with the app’s own tools and verifies every trade it proposes.</span></div>
      ${off ? `<div class="alert warn"><span class="sev">Setup</span><div><div class="at">The agent isn’t switched on yet</div><div class="sub">The site owner needs to add a Claude API key on the server.</div></div></div>` : ''}
      <div class="sub" style="margin:6px 0">${L.kind === 'redraft' ? 'Redraft league: only this season counts, so rebuilding isn’t an option.' : `${KIND_LABEL[L.kind]} league: future picks and young players count.`} Pick a goal:</div>
      <div class="goalgrid">${goals.map(g => `<button class="goal ${st.goal === g.key ? 'on' : ''}" data-goal="${g.key}" ${st.busy ? 'disabled' : ''}><b>${esc(g.label)}</b><span>${esc(g.sub)}</span></button>`).join('')}</div>
      <div class="gmactions"><button id="gmRun" class="runbtn" ${off || st.busy ? 'disabled' : ''}>${st.busy ? 'Working…' : st.plan ? 'Run again' : 'Run GM agent'}</button><button id="gmStop" class="linkbtn" style="${st.busy ? '' : 'display:none'}">Stop</button>
        <span class="sub">Takes about 20–60 seconds. Every trade is re-checked by the app’s trade calculator before it’s shown.</span></div>
    </div>
    <div id="gmBody">${gmBodyHtml(L, st)}</div>`;
}
function bindGmBody() {
  const L = S.L, st = S.gm; if (!st) return;
  document.querySelectorAll('[data-gmcalc]').forEach(b => b.onclick = () => {
    const t = st.plan.trades[+b.dataset.gmcalc]; if (!t || !t.check || t.check.error) return;
    S.ui.chk = { league: L.league.league_id, a: L.me.rid, rid: t.check.rid, give: [...t.check.give], get: [...t.check.get] };
    S.tab = 'check'; history.replaceState(null, '', location.search + '#check'); render(); window.scrollTo(0, 0);
  });
  const f = $('#gmChatForm'); if (f) f.onsubmit = e => { e.preventDefault(); const i = $('#gmChatInput'); const q = i.value; i.value = ''; gmChat(L, q); };
}
function bindGm() {
  if (!$('#gmRun')) return;
  const L = S.L, st = gmState(L);
  document.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => { if (st.busy) return; st.goal = b.dataset.goal; document.querySelectorAll('[data-goal]').forEach(x => x.classList.toggle('on', x === b)); });
  $('#gmRun').onclick = () => gmRun(L);
  $('#gmStop').onclick = () => { st.stop = true; };
  bindGmBody();
}
