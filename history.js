'use strict';
/* League history (free, from Sleeper): how every player got where he is — drafts, trades, waiver claims, adds, drops —
   across the current season and up to three previous seasons of the same league. */

const HIST_SEASONS = 4;

async function loadHistory(L) {
  const id = L.league.league_id;
  if (S.hist && S.hist.id === id) return S.hist;
  if (S.histLoading === id) return null;
  S.histLoading = id;
  const seasons = [];
  let lg = L.league;
  for (let i = 0; i < HIST_SEASONS && lg; i++) {
    seasons.push(lg);
    lg = lg.previous_league_id && lg.previous_league_id !== '0' ? await j(`${API}/league/${lg.previous_league_id}`, null) : null;
  }
  const maxWeeks = L.sport === 'nba' ? 25 : 18;
  const events = []; // { t, type, season, pid?, ... }
  const trades = [];
  const names = {}; // season -> rid -> team label
  const pickMoves = {}; // "season|round|origRid" -> [{ t, season, from, to, trade }]
  const pickUsed = {};  // "season|round|origRid" -> { t, pid, pickNo, rid }
  await Promise.all(seasons.map(async (sl, si) => {
    const isCur = si === 0;
    const weeks = isCur ? L.curWeek : maxWeeks;
    const [users, rosters, drafts, ...txw] = await Promise.all([
      isCur ? Promise.resolve(null) : j(`${API}/league/${sl.league_id}/users`, []),
      isCur ? Promise.resolve(null) : j(`${API}/league/${sl.league_id}/rosters`, []),
      j(`${API}/league/${sl.league_id}/drafts`, []),
      ...Array.from({ length: weeks }, (_, k) => j(`${API}/league/${sl.league_id}/transactions/${k + 1}`, []))
    ]);
    // team names for this season (current season uses the loaded league)
    const nm = {};
    if (isCur) L.teams.forEach(t => nm[t.rid] = t.name);
    else {
      const um = Object.fromEntries((users || []).map(u => [u.user_id, u]));
      (rosters || []).forEach(r => { const u = um[r.owner_id] || {}; const cur = L.teams.find(t => t.owner_id && t.owner_id === r.owner_id); nm[r.roster_id] = cur ? cur.name : S.demo ? `Former team ${r.roster_id}` : ((u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`); });
    }
    names[sl.season] = nm;
    // drafts
    for (const dr of (drafts || []).filter(d => d.status === 'complete')) {
      const [picks, detail] = await Promise.all([j(`${API}/draft/${dr.draft_id}/picks`, []), j(`${API}/draft/${dr.draft_id}`, {})]);
      const kind = (dr.settings && dr.settings.rounds) <= 5 ? 'rookie draft' : 'startup draft';
      const slotToRid = detail.slot_to_roster_id || dr.slot_to_roster_id || {}; // which team each draft slot originally belonged to
      picks.forEach(pk => { const orig = slotToRid[pk.draft_slot]; if (orig) pickUsed[`${dr.season}|${pk.round}|${orig}`] = { t: dr.start_time || dr.created || 0, pid: pk.player_id, pickNo: pk.pick_no, rid: pk.roster_id, season: dr.season }; });
      picks.forEach(pk => events.push({ t: dr.start_time || dr.created || 0, type: 'draft', season: dr.season, pid: pk.player_id, rid: pk.roster_id || slotToRid[pk.draft_slot], round: pk.round, pick: pk.pick_no, kind,
        name: pk.metadata ? `${pk.metadata.first_name || ''} ${pk.metadata.last_name || ''}`.trim() : '' }));
    }
    // transactions
    txw.flat().filter(t => t && t.status === 'complete').forEach(t => {
      const base = { t: t.status_updated || t.created, season: sl.season };
      if (t.type === 'trade') {
        const got = {}; t.roster_ids.forEach(r => got[r] = { players: [], picks: [], faab: 0 });
        Object.entries(t.adds || {}).forEach(([pid, r]) => got[r] && got[r].players.push(pid));
        (t.draft_picks || []).forEach(dp => got[dp.owner_id] && got[dp.owner_id].picks.push(dp));
        (t.waiver_budget || []).forEach(w => got[w.receiver] && (got[w.receiver].faab += w.amount));
        const tr = { ...base, got, rids: t.roster_ids };
        trades.push(tr);
        (t.draft_picks || []).forEach(dp => (pickMoves[`${dp.season}|${dp.round}|${dp.roster_id}`] = pickMoves[`${dp.season}|${dp.round}|${dp.roster_id}`] || []).push({ ...base, from: dp.previous_owner_id, to: dp.owner_id, trade: tr }));
        Object.entries(t.adds || {}).forEach(([pid, r]) => events.push({ ...base, type: 'trade', pid, rid: r, from: (t.drops || {})[pid], trade: tr }));
      } else {
        Object.entries(t.adds || {}).forEach(([pid, r]) => events.push({ ...base, type: t.type === 'waiver' ? 'waiver' : t.type === 'commissioner' ? 'commish' : 'fa', pid, rid: r, bid: t.settings && t.settings.waiver_bid }));
        Object.entries(t.drops || {}).forEach(([pid, r]) => events.push({ ...base, type: 'drop', pid, rid: r }));
      }
    });
  }));
  events.sort((a, b) => a.t - b.t); trades.sort((a, b) => b.t - a.t);
  Object.values(pickMoves).forEach(a => a.sort((x, y) => x.t - y.t));
  S.hist = { id, events, trades, names, pickMoves, pickUsed, seasons: seasons.map(s => s.season) };
  S.histLoading = null;
  if ((S.tab === 'history' || S.tab === 'strategy') && S.L && S.L.league.league_id === id) render();
  return S.hist;
}

function pickOptions(L, H) {
  const keys = new Set([...Object.keys(L.picks.own), ...Object.keys(H.pickMoves), ...Object.keys(H.pickUsed)]);
  return [...keys].map(k => { const [y, r, o] = k.split('|'); const moved = (H.pickMoves[k] || []).length;
    return { key: k, y, r: +r, label: `${y} ${ORD(+r)} — from ${pickTeam(H, y, +o)}${moved ? ` (traded ${moved}×)` : ''}${H.pickUsed[k] ? ' · used' : ''}` }; })
    .sort((a, b) => (b.y - a.y) || (a.r - b.r) || a.label.localeCompare(b.label));
}
// Pick browser: choose a year and round, then tap the original team (12 buttons instead of a 170-item list)
function pickPicker(L, H) {
  const opts = pickOptions(L, H);
  const years = [...new Set(opts.map(o => o.y))].sort((a, b) => b - a);
  const nextY = L.picks.seasons[0];
  const y = S.ui.hpYear && years.includes(S.ui.hpYear) ? S.ui.hpYear : (years.includes(nextY) ? nextY : years[0]);
  const rounds = [...new Set(opts.filter(o => o.y === y).map(o => o.r))].sort((a, b) => a - b);
  const r = rounds.includes(+S.ui.hpRound) ? +S.ui.hpRound : rounds[0];
  const set = (k, v) => `S.ui.${k}=${v};render()`;
  const list = opts.filter(o => o.y === y && o.r === r).map(o => {
    const orig = +o.key.split('|')[2]; const moved = (H.pickMoves[o.key] || []).length; const used = H.pickUsed[o.key];
    const owner = L.picks.own[o.key]; const ownerName = owner && owner !== orig && L.byRid[owner] ? L.byRid[owner].name : null;
    const tag = used ? `used on ${esc(pname(L, used.pid))}` : ownerName ? `now ${esc(ownerName)}` : moved ? `traded ${moved}×` : 'not traded';
    return `<button class="pickchip ${S.ui.histPick === o.key ? 'on' : ''} ${moved ? 'moved' : ''}" data-pick="${o.key}"><b>${esc(pickTeam(H, y, orig))}</b><span>${tag}</span></button>`;
  }).join('');
  return `<div class="pickbar"><span class="sub">Draft picks</span>
    <select onchange="${set('hpYear', 'this.value')}">${years.map(v => `<option ${v === y ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select onchange="${set('hpRound', '+this.value')}">${rounds.map(v => `<option value="${v}" ${v === r ? 'selected' : ''}>Round ${v}</option>`).join('')}</select>
    <span class="sub">tap a team’s pick to see its path</span></div>
    <div class="pickgrid">${list}</div>`;
}
const teamLabel = (H, season, rid) => (H.names[season] && H.names[season][rid]) || `Team ${rid}`;
const fmtDate = t => t ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
function pickLabel(H, season, dp) { return `<span class="nmlink" data-pick="${dp.season}|${dp.round}|${dp.roster_id}">${dp.season} ${ORD(dp.round)}${dp.roster_id !== dp.owner_id ? ` (${esc(teamLabel(H, season, dp.roster_id))})` : ''}</span>`; }
// a pick's name in the season it belongs to (fall back to the newest season we know)
const pickTeam = (H, season, rid) => (H.names[season] && H.names[season][rid]) || teamLabel(H, H.seasons[0], rid);

function pickTimeline(L, H, key) {
  const [y, r, orig] = key.split('|'); const R = +r, O = +orig;
  const moves = H.pickMoves[key] || [], used = H.pickUsed[key];
  const items = [`<li><div class="sub">${y}</div><div><b>Created</b> — original owner ${esc(pickTeam(H, y, O))}</div></li>`];
  moves.forEach(m => items.push(`<li><div class="sub">${fmtDate(m.t)} · ${m.season}</div><div><b>Traded</b> from ${esc(teamLabel(H, m.season, m.from))} to ${esc(teamLabel(H, m.season, m.to))}<div class="tradebox">${tradeSummary(L, H, m.trade, m.to)}</div></div></li>`));
  let status = '';
  if (used) {
    const p = L.player(used.pid);
    items.push(`<li><div class="sub">${fmtDate(used.t)} · ${used.season} draft</div><div><b>Used</b> by ${esc(pickTeam(H, y, used.rid))} on <span class="nmlink" data-hist="${esc(used.pid)}"><b>${esc(pname(L, used.pid))}</b></span> (pick #${used.pickNo})${L.owner[used.pid] ? ` — now on ${esc(L.byRid[L.owner[used.pid]].name)}` : ' — no longer rostered'}</div></li>`);
    status = `Used on ${esc(pname(L, used.pid))}`;
  } else {
    const ownerRid = L.picks.own[key];
    if (ownerRid) {
      const k = { y, r: R, orig: O }; const val = valueModel(L).pickVal(k);
      status = `Owned by <b>${esc(L.byRid[ownerRid].name)}</b>${k.proj ? ` · projects #${k.proj}` : ''}${val ? ` · value ${Math.round(val).toLocaleString()}` : ''}`;
    } else status = 'Draft not recorded in the seasons shown';
  }
  return `<div class="card" style="margin-bottom:16px"><h2>${y} ${ORD(R)}-round pick <span class="sub">original owner: ${esc(pickTeam(H, y, O))}</span></h2>
    <div class="sub" style="margin-bottom:10px">${status}</div><ol class="tl">${items.join('')}</ol></div>`;
}
function pname(L, pid) { const p = L.player(pid); return p.pos === '?' ? pid : p.name; }

function tradeSummary(L, H, tr, focusRid) {
  const sides = tr.rids.map(r => {
    const g = tr.got[r];
    const items = [...g.players.map(pid => `<b>${esc(pname(L, pid))}</b>`), ...g.picks.map(dp => pickLabel(H, tr.season, dp)), ...(g.faab ? [`$${g.faab} FAAB`] : [])];
    return `<div class="${r === focusRid ? 'tside me' : 'tside'}"><span class="sub">${esc(teamLabel(H, tr.season, r))} got</span> ${items.join(', ') || '<span class="mute">nothing</span>'}</div>`;
  });
  return sides.join('');
}

function eventLine(L, H, e) {
  const team = esc(teamLabel(H, e.season, e.rid));
  switch (e.type) {
    case 'draft': return `<b>Drafted</b> by ${team} — ${e.season} ${e.kind}, round ${e.round} (pick #${e.pick})`;
    case 'trade': return `<b>Traded</b> to ${team}${e.from ? ` from ${esc(teamLabel(H, e.season, e.from))}` : ''}<div class="tradebox">${tradeSummary(L, H, e.trade, e.rid)}</div>`;
    case 'waiver': return `<b>Claimed off waivers</b> by ${team}${e.bid ? ` for $${e.bid} FAAB` : ''}`;
    case 'fa': return `<b>Added as a free agent</b> by ${team}`;
    case 'commish': return `<b>Moved by the commissioner</b> to ${team}`;
    case 'drop': return `<b>Dropped</b> by ${team}`;
  }
  return '';
}

function vHistory(L) {
  const H = S.hist && S.hist.id === L.league.league_id ? S.hist : null;
  if (!H) { loadHistory(L); return `<div class="loading">Reading this league's drafts and transactions${L.kind !== 'redraft' ? ' (up to 4 seasons)' : ''}…</div>`; }
  const pid = S.ui.histPid;
  const options = Object.keys(L.owner).map(L.player).filter(p => p.pos !== '?').sort((a, b) => a.name.localeCompare(b.name));
  const picker = `<div class="controls"><label>Player</label><input list="histList" id="histQ" placeholder="Type a player's name" value="${pid ? esc(pname(L, pid)) : ''}" style="min-width:240px">
    <datalist id="histList">${options.map(p => `<option value="${esc(p.name)}">${esc(p.pos)} · ${esc(L.byRid[L.owner[p.id]].name)}</option>`).join('')}</datalist>
    <label style="margin-left:8px">Team trades</label><select id="histTeam"><option value="">All teams</option>${L.standings.map(t => `<option value="${t.rid}" ${+S.ui.histTeam === t.rid ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    ${pickPicker(L, H)}
    <div class="hint">Seasons covered: ${H.seasons.join(', ')}. Tip: click any player's name or pick anywhere to see its full path.</div>`;
  let timeline = '';
  if (S.ui.histPick) timeline += pickTimeline(L, H, S.ui.histPick);
  if (pid) {
    const p = L.player(pid);
    const evs = H.events.filter(e => e.pid === pid);
    const ownerNow = L.owner[pid] ? L.byRid[L.owner[pid]] : null;
    timeline = `<div class="card" style="margin-bottom:16px"><h2>${plCell(L, p)}</h2>
      <div class="sub" style="margin-bottom:10px">${ownerNow ? `Now on <b>${esc(ownerNow.name)}</b>` : 'Currently a free agent'}${p.value ? ` · market value ${Math.round(p.value).toLocaleString()}` : ''}</div>
      ${evs.length ? `<ol class="tl">${evs.map(e => `<li><div class="sub">${fmtDate(e.t)} · ${e.season}</div><div>${eventLine(L, H, e)}</div></li>`).join('')}</ol>`
        : `<div class="sub">No draft or transaction records for him in ${H.seasons.join(', ')}. He was likely added before the oldest season shown.</div>`}</div>`;
  }
  const tf = S.ui.histTeam ? +S.ui.histTeam : null;
  if (S.ui._histTeamSeen !== S.ui.histTeam) { S.ui._histTeamSeen = S.ui.histTeam; S.ui.histLimit = 8; }
  const allT = H.trades.filter(tr => !tf || tr.rids.includes(tf));
  const lim = S.ui.histLimit || 8;
  const list = allT.slice(0, lim);
  const teamsOf = tr => tr.rids.map(r => esc(teamLabel(H, tr.season, r))).join(' ⇄ ');
  const tradesCard = `<div class="card tlist"><h2>${tf ? esc(L.byRid[tf].name) + '’s trades' : 'Recent trades in this league'} <span class="sub">${allT.length} total</span></h2>
    ${list.length ? list.map(tr => `<details class="trow"><summary><span class="tr-main"><b>${teamsOf(tr)}</b><span class="sub tr-team">${fmtDate(tr.t)}</span></span><span class="tr-meta sub">${tr.rids.reduce((a, r) => a + tr.got[r].players.length + tr.got[r].picks.length, 0)} pieces</span></summary><div class="tr-body">${tradeSummary(L, H, tr, tf || (L.me && L.me.rid))}</div></details>`).join('') : '<div class="sub">No trades found.</div>'}
    ${allT.length > lim ? `<button class="morebtn" data-more="histLimit" data-step="8">Show ${Math.min(8, allT.length - lim)} more of ${allT.length - lim} remaining</button>` : ''}</div>`;
  return `${leagueMeta(L)}${picker}${timeline}${tradesCard}`;
}
