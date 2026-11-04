// Game environment for one NFL week: kickoff time, indoor/outdoor, betting line (spread, total, implied team
// totals) from ESPN's scoreboard, plus an Open-Meteo forecast at the stadium for the kickoff window
// (wind, gusts, rain chance, temperature). Weather is the thing a projection never knows about.
//
// GET /api/games?season=2026&week=9
//   -> { season, week, games: [{ id, home, away, kickoff, venue, city, indoor, state,
//         odds: { spread, ou, fav, favTotal, dogTotal, details } | null,
//         wx: { temp, wind, gust, rainPct, precip, code, label, hours } | null }] }

const ABBR = { WSH: 'WAS' }; // ESPN -> Sleeper team codes
// stadium coordinates by home team; anything else (neutral-site / international) is geocoded from the venue city
const STADIUM = {
  ARI: [33.5276, -112.2626], ATL: [33.7554, -84.4010], BAL: [39.2780, -76.6227], BUF: [42.7738, -78.7870], CAR: [35.2258, -80.8528],
  CHI: [41.8623, -87.6167], CIN: [39.0954, -84.5160], CLE: [41.5061, -81.6995], DAL: [32.7473, -97.0945], DEN: [39.7439, -105.0201],
  DET: [42.3400, -83.0456], GB: [44.5013, -88.0622], HOU: [29.6847, -95.4107], IND: [39.7601, -86.1639], JAX: [30.3240, -81.6373],
  KC: [39.0489, -94.4839], LV: [36.0909, -115.1833], LAC: [33.9535, -118.3392], LAR: [33.9535, -118.3392], MIA: [25.9580, -80.2389],
  MIN: [44.9736, -93.2575], NE: [42.0909, -71.2643], NO: [29.9511, -90.0812], NYG: [40.8135, -74.0745], NYJ: [40.8135, -74.0745],
  PHI: [39.9008, -75.1675], PIT: [40.4468, -80.0158], SEA: [47.5952, -122.3316], SF: [37.4030, -121.9700], TB: [27.9759, -82.5033],
  TEN: [36.1665, -86.7713], WAS: [38.9076, -76.8645]
};
const WMO = c => c == null ? '' : c === 0 ? 'Clear' : c <= 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c <= 48 ? 'Fog' : c <= 57 ? 'Drizzle' : c <= 67 ? 'Rain' : c <= 77 ? 'Snow' : c <= 82 ? 'Showers' : c <= 86 ? 'Snow showers' : 'Thunderstorms';

const fetchJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} for ${u}`); return r.json(); };

async function geocode(city, state, country) {
  try {
    const q = [city, country === 'USA' ? state : country].filter(Boolean).join(', ');
    const g = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5`);
    const hit = (g.results || []).find(r => !state || country !== 'USA' || (r.admin1 || '').toLowerCase().startsWith(String(state).toLowerCase().slice(0, 3))) || (g.results || [])[0];
    return hit ? [hit.latitude, hit.longitude, q] : null;
  } catch { return null; }
}

async function forecast(lat, lon, kickoffIso) {
  const k = new Date(kickoffIso); if (isNaN(k)) return null;
  // forecast window = kickoff local hour .. +3h; Open-Meteo returns local times when timezone=auto
  const day = d => d.toISOString().slice(0, 10);
  const d0 = day(new Date(k.getTime() - 12 * 3600e3)), d1 = day(new Date(k.getTime() + 24 * 3600e3));
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto&start_date=${d0}&end_date=${d1}`;
  let f; for (let i = 0; i < 2 && !f; i++) f = await fetchJson(u).catch(() => null);
  if (!f || !f.hourly) return null;
  const off = f.utc_offset_seconds || 0;
  const local = new Date(k.getTime() + off * 1000);
  const start = local.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const H = f.hourly; let i0 = H.time.findIndex(t => t.slice(0, 13) >= start);
  if (i0 < 0) return null;
  const idx = [i0, i0 + 1, i0 + 2, i0 + 3].filter(i => i < H.time.length);
  const pick = (arr, fn) => { const v = idx.map(i => arr[i]).filter(x => x != null); return v.length ? fn(v) : null; };
  const max = v => Math.max(...v), mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const rainPct = pick(H.precipitation_probability, max) || 0;
  const code = rainPct >= 40 ? pick(H.weather_code, max) : H.weather_code[i0]; // only lead with "Rain" when it's actually likely
  return {
    temp: Math.round(pick(H.temperature_2m, mean)), wind: Math.round(pick(H.wind_speed_10m, max)), gust: Math.round(pick(H.wind_gusts_10m, max)),
    rainPct: Math.round(rainPct), precip: Math.round((pick(H.precipitation, v => v.reduce((a, b) => a + b, 0)) || 0) * 100) / 100,
    code, label: WMO(code), hours: idx.length, localKick: H.time[i0]
  };
}

function parseOdds(c, home, away) {
  const o = (c.odds || [])[0]; if (!o) return null;
  const ou = o.overUnder != null ? +o.overUnder : null;
  let fav = null, spread = o.spread != null ? Math.abs(+o.spread) : null;
  const m = /^([A-Z]{2,4})\s+(-?[\d.]+)/.exec(o.details || '');
  if (m) { fav = ABBR[m[1]] || m[1]; spread = Math.abs(+m[2]); }
  else if (o.homeTeamOdds && o.homeTeamOdds.favorite) fav = home; else if (o.awayTeamOdds && o.awayTeamOdds.favorite) fav = away;
  if (spread === 0 || (o.details || '').toUpperCase() === 'EVEN') fav = null;
  const favTotal = ou != null && spread != null ? Math.round(((ou + spread) / 2) * 10) / 10 : null;
  return { spread, ou, fav, favTotal, dogTotal: favTotal != null ? Math.round((ou - favTotal) * 10) / 10 : null, details: o.details || '', book: o.provider && o.provider.name || '' };
}

module.exports = async (req, res) => {
  const season = String(req.query.season || new Date().getFullYear()).replace(/\D/g, '').slice(0, 4);
  const week = Math.max(1, Math.min(18, parseInt(req.query.week, 10) || 1));
  try {
    const sb = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&dates=${season}`);
    const games = await Promise.all((sb.events || []).map(async ev => {
      const c = (ev.competitions || [])[0] || {};
      const side = ha => (c.competitors || []).find(t => t.homeAway === ha) || {};
      const code = t => { const a = (t.team || {}).abbreviation || ''; return ABBR[a] || a; };
      const home = code(side('home')), away = code(side('away'));
      const v = c.venue || {}, addr = v.address || {};
      const indoor = !!v.indoor;
      const kickoff = ev.date;
      const state = ((ev.status || {}).type || {}).state || 'pre';
      let wx = null;
      if (!indoor && state !== 'post') {
        let loc = STADIUM[home] && (addr.country === 'USA' || !addr.country) && !/neutral/i.test(v.fullName || '') ? STADIUM[home] : null;
        if (!loc) loc = await geocode(addr.city, addr.state, addr.country);
        if (loc) wx = await forecast(loc[0], loc[1], kickoff);
        if (!wx && ev.weather) wx = { temp: ev.weather.temperature, wind: null, gust: null, rainPct: null, precip: null, code: null, label: ev.weather.displayValue || '', hours: 0 };
      }
      return { id: ev.id, home, away, kickoff, venue: v.fullName || '', city: [addr.city, addr.country === 'USA' ? addr.state : addr.country].filter(Boolean).join(', '), indoor, state, odds: parseOdds(c, home, away), wx };
    }));
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ season, week, games }));
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
};
