'use strict';
/* Dynasty strategy report: roster value, core age, luck (all-play record), positional strength, age-cliff sell
   windows, pick capital, a verdict (contend / retool / rebuild) and concrete next moves. Free data only. */

const CLIFF = { nfl: { QB: 33, RB: 27, WR: 29, TE: 30 }, nba: { PG: 31, SG: 31, SF: 31, PF: 31, C: 31 } };

function teamProfile(L, t) {
  const vm = valueModel(L);
  const ps = t.players.map(L.player).filter(p => !NO_TRADE.has(p.pos)).map(p => ({ p, v: vm.playerVal(p) })).sort((a, b) => b.v - a.v);
  const picks = L.hasPicks ? (L.picks.byOwner[t.rid] || []).map(pk => { const k = { ...pk }; return { pk: k, v: vm.pickVal(k) }; }) : [];
  const playerVal = ps.reduce((a, x) => a + x.v, 0), pickVal = picks.reduce((a, x) => a + x.v, 0);
  const core = ps.slice(0, L.slots.filter(s => !NO_TRADE.has(s)).length);
  const cw = core.reduce((a, x) => a + x.v, 0) || 1;
  const coreAge = core.reduce((a, x) => a + (x.p.age || 26) * x.v, 0) / cw;
  // all-play: how often this team outscored everyone else, week by week (completed weeks only)
  let apW = 0, apG = 0;
  (L.weekPts || []).forEach(wk => { const mine = wk[t.rid]; if (mine == null) return; for (const [r, v] of Object.entries(wk)) if (+r !== t.rid) { apG++; if (mine > v) apW++; else if (mine === v) apW += 0.5; } });
  const games = t.wins + t.losses + t.ties;
  const apPct = apG ? apW / apG : null;
  const luck = apPct == null ? null : t.wins + t.ties / 2 - apPct * games;
  return { t, ps, picks, playerVal, pickVal, total: playerVal + pickVal, coreAge, apPct, luck, games };
}

function posGroups(L) { return L.sport === 'nfl' ? ['QB', 'RB', 'WR', 'TE'] : ['PG', 'SG', 'SF', 'PF', 'C']; }

function leagueProfiles(L) {
  if (L._prof) return L._prof;
  const prof = L.teams.map(t => teamProfile(L, t));
  const rankBy = (key, desc = true) => { const s = [...prof].sort((a, b) => desc ? b[key] - a[key] : a[key] - b[key]); s.forEach((x, i) => x[key + 'Rank'] = i + 1); };
  rankBy('total'); rankBy('playerVal'); rankBy('pickVal'); rankBy('coreAge', false);
  // positional strength: value of the top players a team would actually start at each position
  const need = {}; L.slots.forEach(s => { if (eligible(s).length === 1) need[s] = (need[s] || 0) + 1; });
  posGroups(L).forEach(pos => {
    const n = (need[pos] || 1) + (L.sport === 'nfl' && pos !== 'QB' ? 1 : 0);
    prof.forEach(x => x['pos_' + pos] = x.ps.filter(y => y.p.positions.includes(pos)).slice(0, n).reduce((a, y) => a + y.v, 0));
    [...prof].sort((a, b) => b['pos_' + pos] - a['pos_' + pos]).forEach((x, i) => x['posRank_' + pos] = i + 1);
  });
  prof.forEach(x => x.verdict = verdictFor(L, x));
  L._prof = prof;
  return prof;
}

function verdictFor(L, x) {
  const N = L.teams.length, po = L.league.settings.playoff_teams || Math.ceil(N / 2);
  const inPO = x.t.rank <= po, strong = x.totalRank <= Math.ceil(N / 3), weak = x.totalRank > Math.ceil(2 * N / 3);
  if (L.kind === 'redraft') return inPO ? { key: 'win', label: 'Playoff push', cls: 'contender' } : { key: 'chase', label: 'Chasing a spot', cls: 'rebuilder' };
  if (inPO && strong) return { key: 'allin', label: 'All in', cls: 'contender' };
  if (inPO) return { key: 'over', label: 'Overachieving', cls: 'contender' };
  if (strong) return { key: 'under', label: 'Underachieving', cls: 'win-now' };
  if (weak) return { key: 'rebuild', label: 'Rebuild', cls: 'rebuilder' };
  return { key: 'retool', label: 'Retool', cls: 'rebuilder' };
}

const VERDICT_TEXT = {
  allin: 'You have a top-third roster and a playoff spot. Spend future picks (2nd year out and beyond) and young bench players on starters at your weakest position. Protect your core.',
  over: 'You’re winning with a roster the market rates mid-pack or lower. Ride it, but rent veterans cheaply rather than paying with 1st-round picks — the market discounts older players, which is where contenders find value.',
  under: 'Your roster is among the most valuable in the league but your record lags. Don’t sell low — if your luck number is negative, results should come. Buy-low on injured or slumping starters instead.',
  rebuild: 'Bottom-third roster and outside the playoffs. Sell veterans before they hit the age cliff, collect 1sts and young players, and don’t trade your own picks. Losing lineup points now improves your draft slot.',
  retool: 'Middle-of-the-pack roster outside the playoffs. Sell aging veterans, consolidate depth into younger starters, and aim to contend next season rather than this one.',
  win: 'You’re in a playoff spot. Trade bench depth for starters at your weakest position — in redraft, only this season matters.',
  chase: 'You’re outside the playoff line. Target trades and waiver adds that raise your weekly lineup now; next year doesn’t count in redraft.'
};

function vStrategy(L) {
  const prof = leagueProfiles(L);
  const sel = S.ui.stratRid || (L.me ? L.me.rid : L.standings[0].rid);
  const x = prof.find(p => p.t.rid === sel) || prof[0];
  const N = L.teams.length, isMe = L.me && x.t.rid === L.me.rid, you = isMe ? 'You' : esc(x.t.name);
  const vm = valueModel(L);
  const cliffs = CLIFF[L.sport] || {};
  const medianVal = (() => { const all = prof.flatMap(p => p.ps.map(y => y.v)).sort((a, b) => a - b); return all[Math.floor(all.length * 0.6)] || 0; })();
  const keep = new Set(isMe && L.usesKeepers ? store.get('sd_keep_' + L.league.league_id, []) : []);
  const sellWin = x.ps.filter(y => cliffs[y.p.pos] && y.p.age && y.p.age >= cliffs[y.p.pos] - 1 && y.v >= medianVal).slice(0, 5);
  const young = x.ps.filter(y => y.p.age && y.p.age <= 24).slice(0, 5);
  const movers = vm.market ? [...x.ps].filter(y => y.p.trend).sort((a, b) => b.p.trend - a.p.trend) : [];
  const risers = movers.filter(y => y.p.trend > 0).slice(0, 3), fallers = movers.filter(y => y.p.trend < 0).slice(-3).reverse();
  const groups = posGroups(L).map(pos => ({ pos, rank: x['posRank_' + pos], val: x['pos_' + pos] })).sort((a, b) => b.rank - a.rank);
  const weakest = groups[0], strongest = groups[groups.length - 1];
  // concrete next moves
  const moves = [];
  const v = x.verdict.key;
  if ((v === 'rebuild' || v === 'retool') && sellWin.length) moves.push(`Shop ${sellWin.slice(0, 2).map(y => `<b>${esc(y.p.name)}</b> (${y.p.pos}, ${y.p.age})`).join(' and ')} — at or near the age where dynasty value drops fastest.`);
  if (v === 'allin' || v === 'over' || v === 'win' || v === 'chase') moves.push(`Biggest hole: <b>${weakest.pos}</b> (ranks ${weakest.rank} of ${N} in starting value). Target an upgrade there first.`);
  else moves.push(`Thinnest position: <b>${weakest.pos}</b> (${weakest.rank} of ${N}). Prioritise young ${weakest.pos}s when you sell.`);
  if (L.hasPicks) {
    const own1 = x.picks.filter(y => y.pk.r === 1 && y.pk.y === L.picks.seasons[0]).sort((a, b) => b.v - a.v);
    if (v === 'rebuild' || v === 'retool') { if (own1.length) moves.push(`Hold your ${own1.map(y => `${y.pk.y} 1st${y.pk.proj ? ` (proj #${y.pk.proj})` : ''}`).join(' and ')} — it’s the cheapest way to add a young starter.`); }
    else if (v === 'allin') { const fut = x.picks.filter(y => y.pk.y !== L.picks.seasons[0]).sort((a, b) => b.v - a.v)[0]; if (fut) moves.push(`Your best trade chip that doesn’t hurt this year: the <b>${fut.pk.y} ${ORD(fut.pk.r)}</b> (~${Math.round(fut.v).toLocaleString()} value).`); }
  }
  if (x.luck != null && Math.abs(x.luck) >= 1) moves.push(x.luck > 0 ? `${you} ${isMe ? 'are' : 'is'} <b>+${f1(x.luck)} wins</b> luckier than ${isMe ? 'your' : 'their'} scoring suggests — expect some regression; don’t overpay to chase this season.` : `${you} ${isMe ? 'have' : 'has'} been <b>${f1(-x.luck)} wins</b> unlucky — ${isMe ? 'your' : 'their'} scoring deserves a better record. Hold rather than sell.`);
  if ((v === 'rebuild' || v === 'retool') && L.hasPicks && store.get('sd_rule_' + L.league.league_id, 'maxpf') === 'maxpf' && !(x.t.rank <= (L.league.settings.playoff_teams || 0))) moves.push('Draft order uses Max PF for non-playoff teams, so moving productive veterans also improves your pick.');
  if (isMe && L.usesKeepers && !keep.size) moves.push('Tick your keepers in <b>My Team</b> so trade suggestions never offer them.');
  const chips = arr => arr.length ? arr.map(y => `<span class="chip"><span class="pos ${POSCLS(y.p.pos)}">${esc(y.p.pos)}</span> <span data-hist="${esc(y.p.id)}" class="nmlink">${esc(y.p.name)}</span> <span class="mute">${y.p.age || ''}${y.p.trend ? ` · ${y.p.trend > 0 ? '+' : ''}${y.p.trend}` : ''}</span></span>`).join('') : '<span class="sub">None</span>';
  const kpi = (l, val, s) => `<div class="kpi"><div class="l">${l}</div><div class="v">${val}</div><div class="s">${s}</div></div>`;
  const landscape = [...prof].sort((a, b) => a.totalRank - b.totalRank).map(p => `<tr class="${L.me && p.t.rid === L.me.rid ? 'me' : ''}"><td class="n">${p.totalRank}</td><td>${teamCell(p.t, false)}</td><td class="n">${rec(p.t)}</td><td class="n">${Math.round(p.total).toLocaleString()}</td>${L.hasPicks ? `<td class="n">${Math.round(p.pickVal).toLocaleString()}</td>` : ''}<td class="n">${f1(p.coreAge)}</td><td class="n">${p.apPct == null ? '–' : Math.round(p.apPct * 100) + '%'}</td><td class="n ${p.luck > 0.9 ? 'warnc' : p.luck < -0.9 ? 'good' : 'mute'}">${p.luck == null ? '–' : (p.luck > 0 ? '+' : '') + f1(p.luck)}</td><td><span class="badge mode-${p.verdict.cls}">${p.verdict.label}</span></td></tr>`).join('');
  return `<div class="controls"><label>Team</label><select id="stratTeam">${L.standings.map(t => `<option value="${t.rid}" ${t.rid === x.t.rid ? 'selected' : ''}>${L.me && t.rid === L.me.rid ? 'You — ' : ''}${esc(t.name)} (${rec(t)})</option>`).join('')}</select></div>
    ${leagueMeta(L)}
    <div class="card" style="margin-bottom:16px"><div class="grade"><div class="gl" style="font-size:15px;width:auto;padding:0 14px">${x.verdict.label}</div><div><div class="at">${isMe ? 'Your plan' : esc(x.t.name) + '’s outlook'}</div><div class="sub">${VERDICT_TEXT[v]}</div></div></div>
      <h3 style="margin-top:14px">Next moves</h3><ul class="why" style="color:var(--text);font-size:14px">${moves.map(m => `<li>${m}</li>`).join('')}</ul>
      ${isMe ? '<button class="linkbtn" data-goto="trades">Find trades that fit this plan →</button>' : ''}</div>
    <div class="kpis">
      ${kpi('Roster value', `#${x.totalRank}`, `of ${N} · ${Math.round(x.total).toLocaleString()} ${vm.market ? 'FantasyCalc' : 'pts'}`)}
      ${L.hasPicks ? kpi('Pick capital', `#${x.pickValRank}`, `${x.picks.length} picks · ${Math.round(x.pickVal).toLocaleString()}`) : ''}
      ${kpi('Core age', f1(x.coreAge), `value-weighted · #${x.coreAgeRank} youngest`)}
      ${kpi('All-play', x.apPct == null ? '–' : Math.round(x.apPct * 100) + '%', 'record vs every team, every week')}
      ${kpi('Luck', x.luck == null ? '–' : (x.luck > 0 ? '+' : '') + f1(x.luck), 'actual wins minus expected')}
    </div>
    <div class="grid g2">
      <div class="card"><h2>Position strength</h2><div class="hint">Starting-caliber value at each position, ranked against the league (1 = best).</div>
        <div class="tw"><table><thead><tr><th>Pos</th><th class="n">Rank</th><th>Top players</th></tr></thead><tbody>${posGroups(L).map(pos => `<tr><td><span class="pos ${pos}">${pos}</span></td><td class="n ${x['posRank_' + pos] <= 3 ? 'good' : x['posRank_' + pos] > N - 3 ? 'bad' : ''}">${x['posRank_' + pos]}</td><td class="sub">${x.ps.filter(y => y.p.positions.includes(pos)).slice(0, 3).map(y => esc(y.p.name)).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="card"><h2>Age & value watch</h2>
        <h3>Sell window <span class="sub">at or near the ${L.sport === 'nfl' ? 'RB 27 · WR 29 · TE 30 · QB 33' : '31+'} age cliff</span></h3><div class="need">${chips(sellWin)}</div>
        <h3>Young core <span class="sub">24 and under</span></h3><div class="need">${chips(young)}</div>
        ${vm.market ? `<h3>Rising (30-day market)</h3><div class="need">${chips(risers)}</div><h3>Falling (30-day market)</h3><div class="need">${chips(fallers)}</div>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>League landscape</h2><div class="hint">Use this to find partners: contenders with pick capital will pay for veterans; rebuilders will pay for youth and picks. Luck in amber = winning more than their scoring suggests.</div>
      <div class="tw"><table><thead><tr><th class="n">Value #</th><th>Team</th><th class="n">W-L</th><th class="n">Value</th>${L.hasPicks ? '<th class="n">Picks</th>' : ''}<th class="n">Core age</th><th class="n">All-play</th><th class="n">Luck</th><th>Outlook</th></tr></thead><tbody>${landscape}</tbody></table></div></div>`;
}

/* event wiring for history + strategy views */
function bindExtra() {
  const L = S.L;
  document.querySelectorAll('[data-hist]').forEach(el => el.onclick = e => { e.preventDefault(); S.ui.histPid = el.dataset.hist; S.ui.histPick = null; S.tab = 'history'; history.replaceState(null, '', location.search + '#history'); render(); window.scrollTo(0, 0); });
  const hq = $('#histQ'); if (hq) hq.onchange = () => {
    const q = hq.value.trim().toLowerCase(); if (!q) { S.ui.histPid = null; render(); return; }
    const ids = Object.keys(L.owner).concat((S.hist ? S.hist.events.map(e => e.pid) : []));
    const hit = ids.find(id => L.player(id).name.toLowerCase() === q) || ids.find(id => L.player(id).name.toLowerCase().includes(q));
    if (hit) { S.ui.histPid = hit; S.ui.histPick = null; render(); }
  };
  document.querySelectorAll('[data-pick]').forEach(el => el.onclick = e => { e.preventDefault(); S.ui.histPick = el.dataset.pick; S.ui.histPid = null; S.tab = 'history'; history.replaceState(null, '', location.search + '#history'); render(); window.scrollTo(0, 0); });
  const hp = $('#histPick'); if (hp) hp.onchange = () => { S.ui.histPick = hp.value || null; if (hp.value) S.ui.histPid = null; render(); };
  const ht = $('#histTeam'); if (ht) ht.onchange = () => { S.ui.histTeam = ht.value; render(); };
  const st = $('#stratTeam'); if (st) st.onchange = () => { S.ui.stratRid = +st.value; render(); };
}
