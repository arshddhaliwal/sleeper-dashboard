'use strict';
/* Trade risk checks: the things a trade grade alone doesn't show. Used by the Trade Calculator, the Trade Finder and
   the GM Agent. Free data only: Sleeper (injuries, practice, depth charts, schedule, trending drops), FantasyCalc
   (30-day value trend) and the latest player notes from ESPN's public athlete pages (via /api/playernews). */

const RISK_SEV = { high: 0, med: 1, info: 2 };
const OUTISH = new Set(['IR', 'Out', 'PUP', 'Sus', 'NA', 'DNR', 'COV', 'Doubtful']);
const DEPTH_POS = { nfl: new Set(['QB', 'RB', 'TE']), nba: new Set() }; // WRs share the field, so WR2 isn't a backup
const DEPTH_LABEL = (pos, n) => `${pos}${n}`;

function depthIndex(L) {
  if (L._depth) return L._depth;
  const idx = {};
  for (const id of L.pids || []) {
    const p = L.player(id);
    if (!p.team || !p.depthPos || !p.depth) continue;
    (idx[`${p.team}|${p.depthPos}`] = idx[`${p.team}|${p.depthPos}`] || []).push(p);
  }
  Object.values(idx).forEach(a => a.sort((x, y) => x.depth - y.depth));
  return (L._depth = idx);
}
function teamGamesPlayed(L, team) {
  if (!L.schedule || !L.schedule.length) return null;
  return L.schedule.filter(g => (g.home === team || g.away === team) && g.week < L.curWeek).length;
}
function nextBye(L, team) {
  if (!L.schedule || !L.schedule.length || !team) return null;
  const weeks = new Set(L.schedule.filter(g => g.home === team || g.away === team).map(g => g.week));
  const last = Math.max(...L.schedule.map(g => g.week));
  for (let w = L.curWeek; w <= last; w++) if (!weeks.has(w)) return w;
  return null;
}
const newsKey = p => `${p.name}|${p.team || ''}`;
function newsFor(p) { return S.pnews && S.pnews[newsKey(p)]; }

// Pull a return timeline or severity signal out of a player note.
function readNote(story) {
  const s = String(story || '');
  const pick = re => { const m = s.match(re); return m ? m[0] : null; };
  return {
    seasonOver: /season-ending|out for the (rest of the )?season|miss the remainder of the season/i.test(s),
    timeline: pick(/(?:expected to |will |could |likely )?(?:miss|be out|be sidelined)[^.]{0,40}?(?:\d+(?:\s*(?:-|to)\s*\d+)?\s+weeks?|weeks?|week \d+|the next \w+ games?)/i)
      || pick(/(?:return|back)[^.]{0,30}(?:week \d+|after the bye|this (?:week|weekend|sunday))/i)
      || pick(/placed on (?:injured reserve|IR)/i)
  };
}

/* Synchronous checks for one player. side: 'get' (you receive him) or 'give'. Returns [{ sev, text }]. */
function riskSync(L, pid, side = 'get') {
  const p = L.player(pid), out = [];
  if (p.pos === '?' || p.pos === 'DEF' || p.pos === 'K') return out;
  const add = (sev, text) => out.push({ sev, text });
  // 1) his own injury
  if (p.inj) {
    const what = `${p.name} is ${p.inj}${p.body ? ` (${p.body})` : ''}${p.practice ? `, practice: ${p.practice}` : ''}`;
    add(OUTISH.has(p.inj) ? 'high' : 'med', `${what}.${side === 'get' && OUTISH.has(p.inj) ? ' You’d be trading for an injured player.' : ''}`);
  }
  // 2) depth chart: a backup whose production depends on an injured starter
  if (DEPTH_POS[L.sport] && DEPTH_POS[L.sport].has(p.depthPos) && p.depth > 1) {
    const room = depthIndex(L)[`${p.team}|${p.depthPos}`] || [];
    const ahead = room.filter(x => x.depth < p.depth && x.id !== p.id);
    const hurt = ahead.filter(x => x.inj);
    const label = DEPTH_LABEL(p.depthPos, p.depth);
    if (hurt.length) {
      const h = hurt[0], gp = teamGamesPlayed(L, p.team), missed = gp != null && h.gp != null ? gp - h.gp : null;
      add(side === 'get' ? 'high' : 'med', `${p.name} is the ${label} on ${p.team} behind ${h.name}, who is ${h.inj}${h.body ? ` (${h.body})` : ''}${missed > 0 ? ` and has missed ${missed} game${missed > 1 ? 's' : ''}` : ''}. ${side === 'get' ? `His recent numbers may be inflated; his role likely shrinks when ${h.name} returns.` : `Selling now, while ${h.name} is out, gets peak value.`}`);
    } else if (ahead.length && side === 'get') {
      add('info', `${p.name} is the ${label} on ${p.team} behind ${ahead.map(x => x.name).slice(0, 2).join(' and ')}.`);
    }
  }
  // 3) upcoming bye
  const bye = nextBye(L, p.team);
  if (bye != null && bye - L.curWeek <= 1 && side === 'get') add(L.kind === 'redraft' ? 'med' : 'info', `${p.name} is on bye in week ${bye}${bye === L.curWeek ? ' (this week)' : ' (next week)'}.`);
  // 4) age cliff in leagues where next year matters
  const cliff = CLIFF[L.sport] && CLIFF[L.sport][p.pos];
  if (L.kind !== 'redraft' && cliff && p.age && p.age >= cliff && side === 'get') add('med', `${p.name} is ${p.age}; ${p.pos}s usually lose value from about ${cliff}.`);
  // 5) market momentum
  if (p.value && p.trend && Math.abs(p.trend) >= 250) { // ignore big percentages on tiny values
    const pct = Math.round(p.trend / Math.max(p.value - p.trend, 1) * 100);
    if (pct <= -12 && side === 'get') add('med', `${p.name}’s trade value is down ${-pct}% in the last 30 days.`);
    else if (pct >= 15 && side === 'give') add('info', `${p.name}’s value is up ${pct}% in 30 days; you’d be selling high.`);
  }
  // 6) the rest of Sleeper is dropping him
  const dr = L.dropRank && L.dropRank[pid];
  if (dr && dr.rank <= 25 && side === 'get') add('med', `${p.name} is the #${dr.rank} most-dropped player on Sleeper today.`);
  // 7) latest note (once fetched): return timelines and season-ending news
  const n = newsFor(p);
  if (n && n.story) {
    const r = readNote(n.headline + ' ' + n.story);
    if (r.seasonOver) add('high', `Latest note: ${p.name} may be out for the season.`);
    else if (r.timeline && (p.inj || hasHurtStarter(L, p))) add(p.inj ? 'high' : 'med', `Latest note on ${p.name}: “${r.timeline.trim()}”.`);
  }
  return out.sort((a, b) => RISK_SEV[a.sev] - RISK_SEV[b.sev]);
}
function hasHurtStarter(L, p) {
  if (!(p.depth > 1)) return false;
  return (depthIndex(L)[`${p.team}|${p.depthPos}`] || []).some(x => x.depth < p.depth && x.inj);
}

/* Fetch the latest notes for these players (and any injured starters ahead of them), cached per page session. */
async function riskNews(L, pids) {
  S.pnews = S.pnews || {}; S.pnewsTried = S.pnewsTried || new Set();
  const want = new Map();
  for (const id of pids) {
    const p = L.player(id); if (p.pos === '?' || p.pos === 'DEF' || p.pos === 'K') continue;
    want.set(newsKey(p), p);
    if (p.depth > 1) (depthIndex(L)[`${p.team}|${p.depthPos}`] || []).filter(x => x.depth < p.depth && x.inj).forEach(x => want.set(newsKey(x), x));
  }
  const todo = [...want.values()].filter(p => !S.pnewsTried.has(newsKey(p)));
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12); batch.forEach(p => S.pnewsTried.add(newsKey(p)));
    const qs = batch.map(p => [p.name, p.team || '', p.espn || ''].map(x => String(x).replace(/[|,]/g, ' ')).join('|')).join(',');
    try { const d = await (await fetch(`/api/playernews?sport=${L.sport}&p=${encodeURIComponent(qs)}`)).json(); Object.assign(S.pnews, d.items || {}); } catch { }
  }
}

/* Full report for a set of trade items: sync checks plus the latest note for each player. */
async function riskReport(L, sides) {
  const ids = [...(sides.get || []), ...(sides.give || [])];
  await riskNews(L, ids);
  const row = (id, side) => { const p = L.player(id), n = newsFor(p); return { player: p.name, side: side === 'get' ? 'receiving' : 'sending', warnings: riskSync(L, id, side).map(w => `[${w.sev}] ${w.text}`), latest_note: n && n.headline ? `${n.headline}${n.published ? ` (${n.published})` : ''}` : undefined, note_detail: n && n.story ? n.story.slice(0, 400) : undefined }; };
  return [...(sides.get || []).map(id => row(id, 'get')), ...(sides.give || []).map(id => row(id, 'give'))];
}

function riskHtml(L, sides, { compact = false } = {}) {
  const rows = [];
  for (const [side, ids] of [['get', sides.get || []], ['give', sides.give || []]]) for (const id of ids) {
    riskSync(L, id, side).filter(w => !compact || w.sev !== 'info' || side === 'get').forEach(w => rows.push(w));
  }
  if (!rows.length) return '';
  rows.sort((a, b) => RISK_SEV[a.sev] - RISK_SEV[b.sev]);
  return `<div class="risks"><div class="sub">Heads up</div><ul>${rows.map(w => `<li class="risk-${w.sev}">${w.sev === 'high' ? '⚠️ ' : w.sev === 'med' ? '• ' : ''}${esc(w.text)}</li>`).join('')}</ul></div>`;
}
