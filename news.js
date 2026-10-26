'use strict';
/* News & injuries: status changes since last visit, injury report, headlines for your players, trending adds/drops. */

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60); if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function vNews(L) {
  if (!S.news || S.news.sport !== L.sport) { loadNews(L.sport); }
  const mine = L.me ? L.me.players.map(L.player) : [];
  // 1) changes since last visit
  const ch = S.injChanges || [];
  const changes = ch.length ? ch.map(c => `<div class="alert ${OUT.has(c.to) || c.to === 'Doubtful' ? 'crit' : c.to === 'Healthy' ? 'ok' : 'warn'}"><span class="sev">${esc(c.to)}</span><div><div class="at">${esc(c.p.name)}</div><div class="sub">${esc(c.from)} → ${esc(c.to)}${c.p.body ? ' · ' + esc(c.p.body) : ''}</div></div></div>`).join('')
    : `<div class="sub">No injury status changes for your players since you last opened this league here.</div>`;
  // 2) injury report
  const inj = mine.filter(p => p.inj).sort((a, b) => (OUT.has(b.inj) - OUT.has(a.inj)) || (b.newsAt - a.newsAt));
  const injRows = inj.map(p => {
    const slot = L.me.reserve.has(p.id) ? 'IR' : L.me.taxi.has(p.id) ? 'Taxi' : L.me.starters.includes(p.id) ? '<b>Starter</b>' : 'Bench';
    return `<tr><td><span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></td><td>${plCell(L, p)}</td><td>${injTag(p)}</td><td>${esc(p.body || '–')}</td><td>${esc(p.practice || '–')}</td><td>${slot}</td><td class="n mute">${ago(p.newsAt)}</td></tr>`;
  }).join('');
  // 3) headlines
  let heads = '<div class="loading">Loading headlines…</div>';
  if (S.news && S.news.sport === L.sport) {
    const myEspn = new Map(mine.filter(p => p.espn).map(p => [p.espn, p]));
    const leagueEspn = new Map(Object.keys(L.owner).map(L.player).filter(p => p.espn).map(p => [p.espn, p]));
    const showAll = S.ui.newsAll;
    const items = (S.news.items || []).map(n => ({ n, mineP: n.ath.map(a => myEspn.get(a)).filter(Boolean), lgP: n.ath.map(a => leagueEspn.get(a)).filter(Boolean) }))
      .filter(x => showAll ? true : x.mineP.length || x.lgP.length);
    heads = items.length ? items.slice(0, 30).map(({ n, mineP, lgP }) => {
      const tags = mineP.map(p => `<span class="tag st">YOURS · ${esc(p.name)}</span>`).join('') || lgP.slice(0, 2).map(p => `<span class="tag tx">${esc(L.byRid[L.owner[p.id]].name)} · ${esc(p.name)}</span>`).join('');
      return `<div class="news"><div class="sub">${ago(n.t)}${tags ? ' ' + tags : ''}</div><a href="${esc(n.url || '#')}" target="_blank" rel="noopener" class="nh">${esc(n.h)}</a><div class="sub">${esc(n.d)}</div></div>`;
    }).join('') : `<div class="sub">No recent ESPN headlines mention players in this league. <button class="linkbtn" data-newsall="1">Show all headlines</button></div>`;
    if (S.news.error) heads = `<div class="sub">Headlines are unavailable right now.</div>`;
  }
  // 4) trending
  const trend = (arr, kind) => arr.slice(0, 15).map((x, i) => {
    const p = L.player(x.player_id); if (p.pos === '?') return '';
    const o = L.owner[p.id] ? L.byRid[L.owner[p.id]] : null;
    const isMine = L.me && o && o.rid === L.me.rid;
    return `<tr class="${isMine ? 'me' : ''}"><td class="n">${i + 1}</td><td><span class="pos ${POSCLS(p.pos)}">${esc(p.pos)}</span></td><td>${plCell(L, p)}</td><td class="n">${x.count.toLocaleString()}</td><td>${o ? (isMine ? '<b>You</b>' : esc(o.name)) : '<span class="good">Free agent</span>'}</td></tr>`;
  }).join('');
  const tTable = (arr, label) => `<div class="tw"><table><thead><tr><th class="n">#</th><th>Pos</th><th>Player</th><th class="n">${label}</th><th>In this league</th></tr></thead><tbody>${trend(arr)}</tbody></table></div>`;
  return `<div class="grid g2">
    <div class="card"><h2>Since your last visit</h2>${changes}</div>
    <div class="card"><h2>Your injury report</h2>${inj.length ? `<div class="tw"><table><thead><tr><th>Pos</th><th>Player</th><th>Status</th><th>Injury</th><th>Practice</th><th>Slot</th><th class="n">Updated</th></tr></thead><tbody>${injRows}</tbody></table></div>` : '<div class="sub">Everyone on your roster is healthy.</div>'}</div>
  </div>
  <div class="card" style="margin-top:16px"><h2 style="display:flex;justify-content:space-between;gap:8px">Headlines <span class="seg"><button data-newsall="0" class="${S.ui.newsAll ? '' : 'on'}">This league's players</button><button data-newsall="1" class="${S.ui.newsAll ? 'on' : ''}">All ${L.sport.toUpperCase()}</button></span></h2>${heads}</div>
  <div class="grid g2" style="margin-top:16px">
    <div class="card"><h2>Most added on Sleeper (24h)</h2><div class="hint">“Free agent” = you can grab him in this league.</div>${tTable(L.trendAdd, 'Adds')}</div>
    <div class="card"><h2>Most dropped on Sleeper (24h)</h2><div class="hint">Highlighted rows are on your roster.</div>${tTable(L.trendDrop, 'Drops')}</div>
  </div>`;
}

async function loadNews(sport) {
  if (S.newsLoading === sport) return;
  S.newsLoading = sport;
  const d = await j(`/api/news?sport=${sport}`, null);
  S.news = d ? { sport, items: d.items || [] } : { sport, items: [], error: true };
  S.newsLoading = null;
  if (S.tab === 'news' && S.L && S.L.sport === sport) render();
}
