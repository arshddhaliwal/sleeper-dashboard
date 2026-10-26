'use strict';
/* Trade engine: market values (FantasyCalc for NFL, scoring-based fallback otherwise), contender/rebuilder
   modes, 1–2 player packages with picks, fairness + acceptance checks, plain-English reasons. Plus a trade checker. */

const ORD = r => r === 1 ? '1st' : r === 2 ? '2nd' : r === 3 ? '3rd' : r + 'th';
const PKG_W = [1, 0.75, 0.6, 0.5]; // consolidation: one great player is worth more than two good ones

function valueModel(L) {
  if (L._vm) return L._vm;
  const market = !!(L.values && L.values.players && Object.keys(L.values.players).length);
  // fallback: points above replacement, adjusted for age in dynasty/keeper leagues
  let repl = 0;
  if (!market) {
    const ppgs = Object.keys(L.stats).map(L.player).filter(p => p.gp >= (L.sport === 'nfl' ? 2 : 1) && !NO_TRADE.has(p.pos)).map(p => p.blendPpg ?? p.ppg).sort((a, b) => b - a);
    repl = ppgs[Math.min(ppgs.length - 1, L.teams.length * (L.slots.length + 2))] || 0;
  }
  const playerVal = p => {
    if (NO_TRADE.has(p.pos)) return 0;
    if (market) return p.value || 0;
    let v = Math.pow(Math.max(0, (p.blendPpg ?? p.ppg) - repl), 1.5) * 60;
    if (L.kind !== 'redraft' && p.age) v *= p.age <= 24 ? 1.2 : p.age >= 31 ? 0.75 : 1;
    return Math.round(v);
  };
  const ranked = L.teams.flatMap(t => t.players).map(L.player).map(playerVal).sort((a, b) => b - a);
  const order = draftOrder(L, store.get('sd_rule_' + L.league.league_id, 'maxpf')).order;
  const N = L.teams.length;
  const pickVal = pk => {
    const nextY = L.picks.seasons[0];
    let tier = '';
    if (pk.y === nextY) { const pos = order.findIndex(t => t.rid === pk.orig) + 1; tier = pos <= N / 3 ? 'Early' : pos <= 2 * N / 3 ? 'Mid' : 'Late'; pk.proj = pos; }
    const nm = `${pk.y} ${ORD(pk.r)}`;
    if (market && L.values.picks) {
      const P = L.values.picks;
      return P[tier ? `${nm} (${tier})` : nm] || P[nm] || P[`${nm} (Mid)`] || Math.round((P[`${nextY} ${ORD(pk.r)}`] || 0) * 0.85);
    }
    const base = { 1: ranked[N * 3] || 0, 2: ranked[N * 6] || 0, 3: ranked[N * 9] || 0 }[pk.r] || 0;
    return Math.round(base * (tier === 'Early' ? 1.4 : tier === 'Late' ? 0.8 : 1) * (pk.y === nextY ? 1 : 0.85));
  };
  L._vm = { market, playerVal, pickVal };
  return L._vm;
}

function teamMode(L, t) {
  if (L.kind === 'redraft') return 'win-now';
  const n = L.league.settings.playoff_teams || Math.ceil(L.teams.length / 2);
  const g = t.wins + t.losses + t.ties;
  return t.rank <= n || (g && t.wins / g >= 0.5) ? 'contender' : 'rebuilder';
}
const MODE_LABEL = { contender: 'Contending', rebuilder: 'Rebuilding', 'win-now': 'Redraft' };

function itemsFor(L, t, { keepers = null } = {}) {
  const vm = valueModel(L);
  const players = t.players.filter(id => !(keepers && keepers.has(id))).map(L.player)
    .filter(p => !NO_TRADE.has(p.pos)).map(p => ({ kind: 'p', id: p.id, p, val: vm.playerVal(p), name: p.name, pos: p.pos, age: p.age }));
  const picks = L.hasPicks ? (L.picks.byOwner[t.rid] || []).map(pk => {
    const k = { ...pk }; const val = vm.pickVal(k);
    const via = k.orig !== t.rid && L.byRid[k.orig] ? ` (${L.byRid[k.orig].name})` : '';
    return { kind: 'k', id: `pick:${k.y}:${k.r}:${k.orig}`, pk: k, val, name: `${k.y} ${ORD(k.r)}${k.proj ? ' · proj #' + k.proj : ''}${via}`, pos: 'PICK' };
  }) : [];
  return [...players, ...picks];
}

const pkgVal = items => items.map(i => i.val).sort((a, b) => b - a).reduce((a, v, i) => a + v * (PKG_W[i] || 0.4), 0);
const avgAge = items => { const a = items.filter(i => i.kind === 'p' && i.age).map(i => i.age); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };

function evalTrade(L, me, them, give, get) {
  const vGive = pkgVal(give), vGet = pkgVal(get);
  const pct = (vGet - vGive) / Math.max(vGet, vGive, 1);
  const gP = give.filter(i => i.kind === 'p').map(i => i.id), rP = get.filter(i => i.kind === 'p').map(i => i.id);
  const myAct = activePids(L, me), thAct = activePids(L, them);
  const myBase = optimal(L, myAct), thBase = optimal(L, thAct);
  const myAfter = optimal(L, [...myAct.filter(x => !gP.includes(x)), ...rP]);
  const thAfter = optimal(L, [...thAct.filter(x => !rP.includes(x)), ...gP]);
  const thFill = thAfter.lineup.map((s, i) => ({ slot: s.slot, inP: s.p, outP: thBase.lineup[i] && thBase.lineup[i].p })).find(x => x.inP && gP.includes(x.inP.id));
  return { vGive, vGet, pct, myLineup: myAfter.total - myBase.total, thLineup: thAfter.total - thBase.total, thFill,
    ageGive: avgAge(give), ageGet: avgAge(get), picksIn: get.filter(i => i.kind === 'k').length, picksOut: give.filter(i => i.kind === 'k').length };
}

function acceptance(L, them, ev) {
  const theirPct = -ev.pct;
  const mode = teamMode(L, them);
  let thr = -0.05;
  if ((mode === 'contender' || mode === 'win-now') && ev.thLineup > 1) thr = -0.12;
  if (mode === 'rebuilder' && (ev.picksOut > 0 || (ev.ageGive && ev.ageGet && ev.ageGive + 3 <= ev.ageGet))) thr = -0.12;
  if ((mode === 'contender' || mode === 'win-now') && ev.thLineup < -0.3) thr = 0.05; // teams trying to win won't weaken their lineup without a clear value win
  const ok = theirPct >= thr;
  const label = theirPct >= 0.03 ? 'Easy yes for them' : ok ? 'Likely acceptable' : theirPct >= thr - 0.08 ? 'Needs a sweetener' : 'Long shot';
  return { ok, label, cls: theirPct >= 0.03 ? 'good' : ok ? 'good' : theirPct >= thr - 0.08 ? 'warnc' : 'bad' };
}

function reasons(L, me, them, ev) {
  const r = [];
  const mm = teamMode(L, me), tm = teamMode(L, them);
  if (ev.thLineup > 0.3) r.push(`${them.name} (${MODE_LABEL[tm].toLowerCase()}, ${rec(them)}) gets +${f1(ev.thLineup)}/g in their lineup${ev.thFill ? ` — ${esc(ev.thFill.inP.name)} replaces ${ev.thFill.outP ? esc(ev.thFill.outP.name) + ` (${f1(ev.thFill.outP.ppg)}/g)` : 'an empty spot'} at ${ev.thFill.slot}` : ''}.`);
  else if (tm === 'rebuilder' && ev.ageGive && ev.ageGet && ev.ageGive < ev.ageGet) r.push(`${them.name} is rebuilding and gets younger (avg age ${f1(ev.ageGet)} → ${f1(ev.ageGive)}).`);
  if (mm === 'rebuilder') {
    if (ev.picksIn) r.push(`Adds ${ev.picksIn} draft pick${ev.picksIn > 1 ? 's' : ''} to your rebuild.`);
    if (ev.ageGet && ev.ageGive && ev.ageGet < ev.ageGive) r.push(`You get younger: avg age ${f1(ev.ageGive)} → ${f1(ev.ageGet)}.`);
    if (ev.myLineup < -0.5 && store.get('sd_rule_' + L.league.league_id, 'maxpf') === 'maxpf') r.push(`Your lineup drops ${f1(-ev.myLineup)}/g — lowers your Max PF, which helps your draft slot.`);
  } else if (ev.myLineup > 0.3) r.push(`Your lineup improves +${f1(ev.myLineup)}/g.`);
  else if (ev.myLineup < -0.3) r.push(`Your lineup dips ${f1(-ev.myLineup)}/g.`);
  return r;
}

function suggestFor(L, me, them, keep) {
  const mm = teamMode(L, me), tm = teamMode(L, them);
  let give = itemsFor(L, me, { keepers: keep }).filter(i => i.val > 0 && !(i.kind === 'p' && me.reserve.has(i.id)));
  if (mm === 'rebuilder') give = give.filter(i => i.kind === 'p'); // don't sell your own picks while rebuilding
  give = [...give.filter(i => i.kind === 'p').sort((a, b) => b.val - a.val).slice(0, 9), ...give.filter(i => i.kind === 'k').sort((a, b) => b.val - a.val).slice(0, 3)];
  let get = itemsFor(L, them).filter(i => i.val > 0);
  get = [...get.filter(i => i.kind === 'p').sort((a, b) => b.val - a.val).slice(0, 10), ...get.filter(i => i.kind === 'k').sort((a, b) => b.val - a.val).slice(0, 4)];
  // pairs only when the second piece actually matters (no junk throw-ins)
  const combos = arr => { const c = arr.map(x => [x]); for (let i = 0; i < arr.length; i++) for (let k = i + 1; k < arr.length; k++) if (Math.min(arr[i].val, arr[k].val) >= 0.15 * Math.max(arr[i].val, arr[k].val)) c.push([arr[i], arr[k]]); return c; };
  const G = combos(give), R = combos(get);
  const out = [];
  for (const g of G) {
    const vg = pkgVal(g);
    for (const r of R) {
      if (g.length === 2 && r.length === 2 && g.some(x => x.kind === 'k') && r.some(x => x.kind === 'k')) continue;
      if (g.every(x => x.kind === 'k') && r.every(x => x.kind === 'k')) continue; // pick-for-pick swaps aren't useful ideas
      const vr = pkgVal(r);
      const pct = (vr - vg) / Math.max(vr, vg, 1);
      if (pct < -0.02 || pct > 0.2 || Math.max(vr, vg) < 400) continue;
      const ev = evalTrade(L, me, them, g, r);
      const acc = acceptance(L, them, ev);
      if (!acc.ok) continue;
      if (Math.abs(ev.pct) < 0.02 && Math.abs(ev.myLineup) < 0.3 && Math.abs(ev.thLineup) < 0.3 && !ev.picksIn) continue; // a wash for both sides
      let score = ev.pct * 100;
      if (mm === 'rebuilder') {
        score += ev.picksIn * 5 + (ev.ageGive && ev.ageGet ? (ev.ageGive - ev.ageGet) * 1.5 : 0);
        if (ev.myLineup < 0 && store.get('sd_rule_' + L.league.league_id, 'maxpf') === 'maxpf') score += Math.min(4, -ev.myLineup * 0.5);
      } else score += ev.myLineup * 4;
      score += Math.min(4, ev.thLineup); // trades that clearly help them get done
      out.push({ g, r, ev, acc, score });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const picked = [], seen = {};
  for (const o of out) {
    const key = o.r.map(x => x.id).sort().join('|');
    const main = o.r.slice().sort((a, b) => b.val - a.val)[0].id;
    if (seen[key] || (seen['m' + main] || 0) >= 2) continue;
    seen[key] = 1; seen['m' + main] = (seen['m' + main] || 0) + 1;
    picked.push(o); if (picked.length >= 3) break;
  }
  return picked;
}

const itemChip = i => `<span class="chip">${i.kind === 'k' ? '<span class="pos">PICK</span>' : `<span class="pos ${POSCLS(i.pos)}">${esc(i.pos)}</span>`} ${esc(i.name)}${i.kind === 'p' && i.age ? ` <span class="mute">${i.age}</span>` : ''} <span class="mute">${Math.round(i.val).toLocaleString()}</span></span>`;

function tradeCard(L, me, them, o) {
  const rs = reasons(L, me, them, o.ev);
  return `<div class="trade">
    <div class="tside"><div class="sub">You give</div><div class="need">${o.g.map(itemChip).join('')}</div></div>
    <div class="tside"><div class="sub">You get</div><div class="need">${o.r.map(itemChip).join('')}</div></div>
    <div class="tmeta"><span class="gain ${o.ev.pct >= 0 ? 'good' : 'bad'}">${o.ev.pct >= 0 ? '+' : ''}${Math.round(o.ev.pct * 100)}% value</span> <span class="tag ${o.acc.cls === 'good' ? 'st' : 'q'}">${o.acc.label}</span>
      <button class="linkbtn" data-open-check="${them.rid}" data-give="${o.g.map(x => x.id).join(',')}" data-get="${o.r.map(x => x.id).join(',')}">Open in calculator →</button></div>
    ${rs.length ? `<ul class="why">${rs.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function vTrades(L) {
  if (!L.me) return `<div class="card">You don't have a team in this league.</div>`;
  const vm = valueModel(L);
  const me = L.me;
  const keep = new Set(L.usesKeepers ? store.get('sd_keep_' + L.league.league_id, []) : []);
  const target = S.ui.target || 'winning';
  const teamF = S.ui.tfTeam ? +S.ui.tfTeam : null;
  const limit = S.ui.tfLimit || 6;
  const mm = teamMode(L, me);
  let targets = L.standings.filter(t => t.rid !== me.rid);
  if (teamF) targets = targets.filter(t => t.rid === teamF);
  else if (target === 'winning') targets = targets.filter(t => teamMode(L, t) !== 'rebuilder' && (t.wins >= t.losses));
  // one ranked list across teams (cached per league + filters so expanding rows doesn't recompute)
  const ck = [L.league.league_id, target, teamF, [...keep].sort().join(',')].join('|');
  if (!L._tf || L._tf.key !== ck) L._tf = { key: ck, list: targets.flatMap(t => suggestFor(L, me, t, keep).map(o => ({ ...o, t }))).sort((a, b) => b.score - a.score) };
  const all = L._tf.list;
  const rows = all.slice(0, limit).map((o, i) => tradeRow(L, me, o, i)).join('');
  const nd = teamF ? needs(L, L.byRid[teamF]).filter(x => !['K', 'DEF'].includes(x.slot) && x.diff < -0.05).sort((a, b) => a.diff - b.diff).slice(0, 3) : [];
  const modeLine = mm === 'rebuilder' ? 'You’re <b>rebuilding</b>: selling veterans for picks and younger players, never your own picks.'
    : mm === 'contender' ? 'You’re <b>contending</b>: trades that improve your starting lineup now.'
    : 'Redraft: player-for-player trades that improve your lineup.';
  return `<div class="controls"><div class="seg">
      <button data-target="winning" class="${target === 'winning' && !teamF ? 'on' : ''}">Contenders</button>
      <button data-target="all" class="${target === 'all' && !teamF ? 'on' : ''}">All teams</button></div>
      <select id="tfTeam"><option value="">Any team</option>${L.standings.filter(t => t.rid !== me.rid).map(t => `<option value="${t.rid}" ${teamF === t.rid ? 'selected' : ''}>${esc(t.name)} (${rec(t)})</option>`).join('')}</select>
      <span class="sub">${L.usesKeepers ? (keep.size ? `Protecting ${keep.size} keepers.` : 'Tip: tick keepers in My Team.') : ''}</span></div>
    <div class="hint">${modeLine} Ranked best-first; tap a trade for the reasoning. Values: ${vm.market ? 'FantasyCalc' : 'scoring-based'}.</div>
    ${nd.length ? `<div class="need">${nd.map(x => `<span class="chip ${x.diff < -1 ? 'bad' : ''}">${esc(L.byRid[teamF].name)} needs ${esc(x.slot)} <b class="bad">${f1(x.diff)}</b></span>`).join('')}</div>` : ''}
    <div class="card tlist">${rows || '<div class="sub">No balanced trades found. Try “All teams”, another team, or untick a keeper.</div>'}
    ${all.length > limit ? `<button class="morebtn" data-more="tfLimit" data-step="6">Show ${Math.min(6, all.length - limit)} more of ${all.length - limit} remaining</button>` : ''}</div>`;
}

const shortItem = i => i.kind === 'k' ? `${esc(i.pk.y)} ${ORD(i.pk.r)}${i.pk.proj ? ` <span class="mute">#${i.pk.proj}</span>` : ''}` : esc(i.name);
function tradeRow(L, me, o, i) {
  const rs = reasons(L, me, o.t, o.ev);
  return `<details class="trow"><summary>
      <span class="rk">${i + 1}</span>
      <span class="tr-main"><span class="tr-give">${o.g.map(shortItem).join(' + ')}</span> <span class="arrow">→</span> <b>${o.r.map(shortItem).join(' + ')}</b><span class="sub tr-team">${esc(o.t.name)} · ${MODE_LABEL[teamMode(L, o.t)]}</span></span>
      <span class="tr-meta"><span class="gain ${o.ev.pct >= 0 ? 'good' : 'bad'}">${o.ev.pct >= 0 ? '+' : ''}${Math.round(o.ev.pct * 100)}%</span><span class="tag ${o.acc.cls === 'good' ? 'st' : 'q'}">${o.acc.label}</span></span>
    </summary>
    <div class="tr-body">
      <div class="tside"><div class="sub">You give</div><div class="need">${o.g.map(itemChip).join('')}</div></div>
      <div class="tside"><div class="sub">You get</div><div class="need">${o.r.map(itemChip).join('')}</div></div>
      ${rs.length ? `<ul class="why">${rs.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
      <button class="linkbtn" data-open-check="${o.t.rid}" data-give="${o.g.map(x => x.id).join(',')}" data-get="${o.r.map(x => x.id).join(',')}">Open in calculator →</button>
    </div></details>`;
}

/* ---------- Trade calculator (any two teams) ---------- */
function vCheck(L) {
  const first = L.me || L.standings[0];
  const c = S.ui.chk && S.ui.chk.league === L.league.league_id ? S.ui.chk
    : (S.ui.chk = { league: L.league.league_id, a: first.rid, rid: L.standings.find(t => t.rid !== first.rid).rid, give: [], get: [] });
  if (!c.a) c.a = first.rid;
  const me = L.byRid[c.a] || first;
  const others = L.standings.filter(t => t.rid !== me.rid);
  if (c.rid === me.rid) c.rid = others[0].rid;
  const them = L.byRid[c.rid] || others[0];
  const isMe = L.me && me.rid === L.me.rid;
  const who = isMe ? 'You' : esc(me.name);
  const mine = itemsFor(L, me), theirs = itemsFor(L, them);
  const list = (items, side) => items.sort((a, b) => b.val - a.val).map(i => `<label class="ck"><input type="checkbox" class="chk" data-chk="${side}" value="${esc(i.id)}" ${c[side].includes(i.id) ? 'checked' : ''}> ${i.kind === 'k' ? '<span class="pos">PICK</span>' : `<span class="pos ${POSCLS(i.pos)}">${esc(i.pos)}</span>`} <span class="nm">${esc(i.name)}</span>${i.kind === 'p' && i.age ? ` <span class="mute">${i.age}</span>` : ''}${i.kind === 'p' ? injTag(i.p) : ''}<span class="mute" style="margin-left:auto">${Math.round(i.val).toLocaleString()}</span></label>`).join('');
  const give = mine.filter(i => c.give.includes(i.id)), get = theirs.filter(i => c.get.includes(i.id));
  let verdict = '<div class="sub">Tick players or picks on both sides to grade the trade.</div>';
  if (give.length && get.length) {
    const ev = evalTrade(L, me, them, give, get), acc = acceptance(L, them, ev), rs = reasons(L, me, them, ev);
    const g = ev.pct >= 0.15 ? ['A', 'Big win for you', 'good'] : ev.pct >= 0.05 ? ['B+', 'Win for you', 'good'] : ev.pct >= -0.05 ? ['B', 'Fair trade', 'good'] : ev.pct >= -0.15 ? ['C', 'You’re overpaying a bit', 'warnc'] : ['D', 'You’re overpaying', 'bad'];
    if (!isMe) g[1] = g[1].replace('for you', 'for ' + me.name).replace('You’re', me.name + ' is');
    verdict = `<div class="grade"><div class="gl ${g[2]}">${g[0]}</div><div><div class="at">${g[1]}</div><div class="sub">Value: ${isMe ? 'you give' : who + ' gives'} ${Math.round(ev.vGive).toLocaleString()} · ${isMe ? 'you get' : 'gets'} ${Math.round(ev.vGet).toLocaleString()} (${ev.pct >= 0 ? '+' : ''}${Math.round(ev.pct * 100)}%)</div></div></div>
      <div class="kpis" style="margin-top:12px"><div class="kpi"><div class="l">${isMe ? 'Your' : esc(me.name)} lineup</div><div class="v ${ev.myLineup >= 0 ? 'good' : 'bad'}">${ev.myLineup >= 0 ? '+' : ''}${f1(ev.myLineup)}</div><div class="s">pts/g at season pace</div></div>
      <div class="kpi"><div class="l">Their lineup</div><div class="v ${ev.thLineup >= 0 ? 'good' : 'bad'}">${ev.thLineup >= 0 ? '+' : ''}${f1(ev.thLineup)}</div><div class="s">pts/g at season pace</div></div>
      <div class="kpi"><div class="l">Would they accept?</div><div class="v" style="font-size:18px">${acc.label}</div><div class="s">${MODE_LABEL[teamMode(L, them)]} team</div></div></div>
      ${rs.length ? `<ul class="why">${rs.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}`;
  }
  return `<div class="controls"><label>Team A</label><select id="chkA">${L.standings.map(t => `<option value="${t.rid}" ${t.rid === me.rid ? 'selected' : ''}>${L.me && t.rid === L.me.rid ? 'You — ' : ''}${esc(t.name)} (${rec(t)})</option>`).join('')}</select>
    <label>Team B</label><select id="chkTeam">${others.map(t => `<option value="${t.rid}" ${t.rid === them.rid ? 'selected' : ''}>${esc(t.name)} (${rec(t)})</option>`).join('')}</select>
    <button class="linkbtn" data-chk-clear="1">Clear</button></div>
    ${leagueMeta(L)}
    <div class="card" style="margin-bottom:16px">${verdict}</div>
    <div class="grid g2"><div class="card"><h2>${who} give${isMe ? '' : 's'}</h2><div class="cklist">${list(mine, 'give')}</div></div>
    <div class="card"><h2>${who} get${isMe ? '' : 's'} <span class="sub">from ${esc(them.name)}</span></h2><div class="cklist">${list(theirs, 'get')}</div></div></div>
    <div class="hint" style="margin-top:12px">Numbers next to each name are ${valueModel(L).market ? 'FantasyCalc market values' : 'scoring-based values'}. Grades: A ≥ +15%, B+ ≥ +5%, B within ±5%, C to −15%, D below.</div>`;
}

/* ---------- shared event wiring for module views ---------- */
function bindModules() {
  const L = S.L;
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { S.tab = b.dataset.goto; history.replaceState(null, '', location.search + '#' + S.tab); render(); window.scrollTo(0, 0); });
  document.querySelectorAll('[data-newsall]').forEach(b => b.onclick = () => { S.ui.newsAll = b.dataset.newsall === '1'; render(); });
  document.querySelectorAll('[data-open-check]').forEach(b => b.onclick = () => {
    S.ui.chk = { league: L.league.league_id, a: L.me.rid, rid: +b.dataset.openCheck, give: b.dataset.give.split(','), get: b.dataset.get.split(',') };
    S.tab = 'check'; history.replaceState(null, '', location.search + '#check'); render(); window.scrollTo(0, 0);
  });
  document.querySelectorAll('[data-target]').forEach(b => b.addEventListener('click', () => { S.ui.tfTeam = ''; S.ui.tfLimit = 6; }, { capture: true }));
  const tf = $('#tfTeam'); if (tf) tf.onchange = () => { S.ui.tfTeam = tf.value; S.ui.tfLimit = 6; render(); };
  document.querySelectorAll('[data-more]').forEach(b => b.onclick = () => { const k = b.dataset.more; S.ui[k] = (S.ui[k] || +b.dataset.step) + +b.dataset.step; const y = window.scrollY; render(); window.scrollTo(0, y); });
  const ct = $('#chkTeam'); if (ct) ct.onchange = () => { S.ui.chk = { ...S.ui.chk, rid: +ct.value, get: [] }; render(); };
  const ca = $('#chkA'); if (ca) ca.onchange = () => { S.ui.chk = { ...S.ui.chk, a: +ca.value, give: [], get: [] }; render(); };
  document.querySelectorAll('[data-chk]').forEach(cb => cb.onchange = () => {
    const side = cb.dataset.chk, arr = S.ui.chk[side];
    if (cb.checked) arr.push(cb.value); else arr.splice(arr.indexOf(cb.value), 1);
    const y = window.scrollY; render(); window.scrollTo(0, y);
  });
  const cl = document.querySelector('[data-chk-clear]'); if (cl) cl.onclick = () => { S.ui.chk.give = []; S.ui.chk.get = []; render(); };
}
