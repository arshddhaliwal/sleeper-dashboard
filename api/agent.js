// GM Agent backend. A Claude tool-use loop whose tools run in the browser against the league data the app already
// computed. This function holds the API key, the system prompts and the tool definitions, and relays one model
// turn at a time; the browser executes tool calls and sends the results back on the next request.
//
// GET  /api/agent                          -> { enabled, model, tools }
// POST /api/agent { mode, messages, context } -> { text, calls: [{ id, name, args }] }
//   mode: 'gm' (autonomous plan toward a goal) | 'chat' (follow-up questions)
//
// Neutral message format sent by the browser:
//   { role: 'user', text } | { role: 'assistant', text?, calls?: [{ id, name, args }] } | { role: 'tool', id, name, result }

const VERSION = '2026-10-28.5'; // must match AGENT_VERSION in agent.js

const TOOLS = [
  { name: 'get_league_overview', description: 'League type (dynasty / keeper / redraft), scoring, settings, the standings (rank, record, points, max points, contend-or-rebuild verdict, roster value rank) and which team is the user\'s.', params: {} },
  { name: 'scan_league_needs', description: 'For every team: contend/rebuild mode, roster value rank, and its weakest and strongest starting positions versus the league median. Use it to find trade partners whose needs match what the user can offer.', params: {} },
  { name: 'get_team_roster', description: 'Full roster of one team: each player with position, age, points per game in this league\'s scoring, market value, injury, lineup role (starter/bench/IR/taxi), plus the team\'s draft picks with values.', params: { team: { type: 'string', description: 'Team name, or "me" for the user\'s team' } }, required: ['team'] },
  { name: 'get_team_strategy', description: 'Strategy profile for a team: verdict and advice, roster/player/pick value ranks, core age, luck (record vs all-play), strength rank at each position, top assets, aging-cliff risks.', params: { team: { type: 'string', description: 'Team name, or "me"' } }, required: ['team'] },
  { name: 'find_players', description: 'Search players by name and/or position across rosters and free agents, ranked by points per game. Use free_agents_only for waiver targets.', params: { name: { type: 'string', description: 'Part of a player name (optional)' }, position: { type: 'string', description: 'QB, RB, WR, TE, K, DEF (NFL) or PG, SG, SF, PF, C (NBA). Optional.' }, free_agents_only: { type: 'boolean' }, limit: { type: 'integer', description: 'Default 10, max 25' } } },
  { name: 'suggest_trades', description: 'Run the app\'s trade engine for the user: balanced trades the other side is likely to accept, ranked, with reasons. It already respects the user\'s mode (contending teams buy, rebuilding teams sell veterans and never sell their own picks; redraft has no picks).', params: { with_team: { type: 'string', description: 'Only this trade partner (optional)' }, limit: { type: 'integer', description: 'Default 5, max 10' } } },
  { name: 'shop_players', description: 'Shop specific players/picks the user wants to move: searches every team (or one) for packages they would likely accept in exchange for exactly these items, ranked by value and lineup impact. Use whenever the user names players they want to trade away. To compare alternatives (e.g. A+B+C vs A+B+D), call it once per combination.', params: { give: { type: 'array', items: { type: 'string' }, description: 'Players or picks the user gives, all included' }, with_team: { type: 'string', description: 'Only this partner (optional)' }, limit: { type: 'integer', description: 'Default 5, max 8' } }, required: ['give'] },
  { name: 'evaluate_trade', description: 'Grade a specific trade: value of each side (with a consolidation premium), lineup impact for both teams, and whether the other side would likely accept. Picks look like "2027 1st". Use it to check or tweak any trade before recommending it.', params: { give: { type: 'array', items: { type: 'string' } }, get: { type: 'array', items: { type: 'string' } }, other_team: { type: 'string' }, from_team: { type: 'string', description: 'Defaults to the user' } }, required: ['give', 'get', 'other_team'] },
  { name: 'get_player_history', description: 'How a player reached his current team: drafts, trades, waiver claims and drops across up to four seasons.', params: { player: { type: 'string' } }, required: ['player'] },
  { name: 'get_draft_order', description: 'Projected order of next year\'s draft if the season ended today, and who owns each first-round pick. Dynasty and keeper leagues only.', params: {} },
  { name: 'get_player_news', description: 'Recent ESPN headlines and current injury/practice status, for one player or (if none given) for the user\'s whole roster.', params: { player: { type: 'string', description: 'Player name (optional)' } } },
  { name: 'check_player_risks', description: 'Risk check for specific players: injury and practice status, depth-chart role (e.g. a backup whose production depends on an injured starter), latest player note with any return timeline, upcoming bye, age cliff, falling market value, and whether Sleeper users are dropping him.', params: { players: { type: 'array', items: { type: 'string' } }, side: { type: 'string', description: '"get" if the user would receive them (default), "give" if sending them' } }, required: ['players'] },
  { name: 'get_lineup_alerts', description: 'Problems in the user\'s lineup this week: injured/doubtful/bye starters, empty slots, better bench options, IR moves, hot free agents.', params: {} },
  { name: 'get_matchups', description: 'This week\'s matchups with current scores, projected finals and players left.', params: {} }
];

const SUBMIT = {
  name: 'submit_gm_plan',
  description: 'Submit the final GM plan. Call exactly once, at the end, after you have verified every trade with evaluate_trade.',
  params: {
    goal: { type: 'string', description: 'The goal you planned for (if the user let you decide, the one you chose)' },
    verdict: { type: 'string', description: 'One sentence: where this team stands and why' },
    reasoning: { type: 'string', description: '2-4 sentences on the evidence behind the strategy (standings, value ranks, luck, ages, needs)' },
    trades: { type: 'array', description: '1-3 recommended trades, best first', items: { type: 'object', properties: {
      partner: { type: 'string' }, give: { type: 'array', items: { type: 'string' } }, get: { type: 'array', items: { type: 'string' } },
      why: { type: 'string', description: 'Why this helps the user AND why the partner says yes' }, pitch: { type: 'string', description: 'A short, friendly message the user could send the partner' }
    }, required: ['partner', 'give', 'get', 'why'] } },
    waiver_adds: { type: 'array', items: { type: 'object', properties: { add: { type: 'string' }, drop: { type: 'string' }, why: { type: 'string' } }, required: ['add', 'why'] } },
    lineup_fixes: { type: 'array', items: { type: 'string' } },
    watch_list: { type: 'array', items: { type: 'string' }, description: 'Risks or things to revisit (injuries, aging players, byes)' }
  },
  required: ['goal', 'verdict', 'reasoning', 'trades']
};

const BASE_RULES = `You work inside SleeperDash, a fantasy sports dashboard, on the one league the user has loaded. Every tool returns real data computed by the app: this league's scoring, FantasyCalc market values (NFL), and the app's own trade engine.

Ground rules:
- Use only tool results. Never invent players, stats, values, records, picks or trades.
- "I", "me", "my team" = the team marked "(user)".
- League type rules:
  * REDRAFT: only this season matters. There are no future picks and no keepers. Never recommend rebuilding, selling for the future, or acquiring picks. Valid strategies are winning now or a playoff push (and if the team is out of contention, maximising weekly wins anyway).
  * DYNASTY: the whole roster carries over; future picks are tradeable. Contend, retool or rebuild are all valid.
  * KEEPER: only a few players carry over; weigh this season more than in dynasty and value keeper-eligible youth.
- Team and manager names may be anonymised in demo mode; use them exactly as tools return them.
- Only discuss this league and fantasy sports.
- Never mention tool or function names to the user, and never describe your internal process ("I ran X"). Just give the answer in plain fantasy terms.
- Trade results include "warnings" and a "risk_check". Always tell the user about high and medium warnings on the players in a trade you discuss: injuries and return timelines from the latest note, backups whose numbers depend on an injured starter (and what happens when the starter returns), byes, age, and falling value. Don't recommend a trade whose main piece has a high warning without saying so plainly, and prefer an alternative when one exists.
- If a tool returns an error, try another way to get the answer (a different tool, a corrected name) before telling the user you can't.`;

const GM_PROMPT = `${BASE_RULES}

You are the user's autonomous General Manager. Given a goal, work in steps without asking the user anything:
1. Assess: get_league_overview, then get_team_strategy and get_team_roster for the user's team.
2. Decide the strategy. If the goal is "let the agent decide", pick it from the evidence (standings, roster value rank, luck, core age, league type). In a redraft league you may only choose win-now or playoff push.
3. Find partners: scan_league_needs, then suggest_trades (overall and/or with the best-fitting partners). Look at partner rosters when useful.
4. Build 1-3 trades that serve the goal. Verify EVERY trade with evaluate_trade; if the other side is unlikely to accept or the value is lopsided, adjust and re-check. Don't recommend a trade you haven't verified.
5. Check get_lineup_alerts and free agents (find_players with free_agents_only) for quick wins.
6. Call submit_gm_plan once with the final plan. Use exact player and team names from the tools.
Work efficiently: batch independent tool calls in the same turn. Aim to finish in about 8 turns.`;

const CHAT_PROMPT = `${BASE_RULES}

Answer the user's follow-up questions about the league and the GM plan (if one is in the conversation). Call tools whenever you need data. Be concise and concrete (under ~180 words unless asked for detail), name players, teams and numbers, and use short bullets where they help.`;

// Best-effort per-instance rate limit (serverless instances don't share memory; it only blunts bursts).
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 80;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const model = () => process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY || process.env.AGENT_MOCK === '1';

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
function sanitize(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  const out = messages.slice(-80).map(m => {
    if (m.role === 'user') return { role: 'user', text: clip(m.text, 8000) };
    if (m.role === 'assistant') return { role: 'assistant', text: clip(m.text, 6000), calls: (m.calls || []).slice(0, 8).map(c => ({ id: clip(c.id, 80), name: clip(c.name, 60), args: c.args && typeof c.args === 'object' ? c.args : {} })) };
    if (m.role === 'tool') return { role: 'tool', id: clip(m.id, 80), name: clip(m.name, 60), result: clip(typeof m.result === 'string' ? m.result : JSON.stringify(m.result), 12000) };
    throw new Error('bad role');
  });
  if (!out.length || out[0].role !== 'user') throw new Error('conversation must start with a user message');
  return out;
}

function toAnthropic(msgs) {
  const messages = [];
  const push = (role, block) => { const last = messages[messages.length - 1]; if (last && last.role === role) last.content.push(block); else messages.push({ role, content: [block] }); };
  for (const m of msgs) {
    if (m.role === 'user') push('user', { type: 'text', text: m.text || ' ' });
    else if (m.role === 'assistant') {
      if (m.text) push('assistant', { type: 'text', text: m.text });
      for (const c of m.calls || []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
    } else push('user', { type: 'tool_result', tool_use_id: m.id, content: m.result });
  }
  // incremental prompt caching: the conversation so far is reused on the next loop turn
  const last = messages[messages.length - 1];
  if (last && last.content.length) last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  return messages;
}

async function callClaude(mode, system, msgs, allowed) {
  const defs = (mode === 'gm' ? [...TOOLS, SUBMIT] : TOOLS).filter(t => t === SUBMIT || !allowed || allowed.has(t.name)).map(t => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: t.params, required: t.required || [] } }));
  defs[defs.length - 1].cache_control = { type: 'ephemeral' }; // cache the long, stable tool + system prefix across loop turns
  const payload = JSON.stringify({ model: model(), max_tokens: mode === 'gm' ? 3000 : 1200, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools: defs, messages: toAnthropic(msgs) });
  let r, j;
  for (let attempt = 0; attempt < 3; attempt++) { // retry rate limits and overloads with backoff
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: payload });
    j = await r.json().catch(() => ({}));
    if (r.ok || ![429, 500, 502, 503, 529].includes(r.status)) break;
    await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
  }
  if (!r.ok) throw new Error(r.status === 529 || r.status === 503 ? 'Claude is overloaded right now. Try again in a minute.' : (j.error && j.error.message) || `Claude API error ${r.status}`);
  if (j.stop_reason === 'max_tokens' && !(j.content || []).some(b => b.type === 'tool_use')) j.content = [...(j.content || []), { type: 'text', text: '\n\n(Answer cut short. Ask me to continue.)' }];
  return {
    text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
    calls: (j.content || []).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })),
    usage: j.usage ? { in: j.usage.input_tokens, out: j.usage.output_tokens, cached: j.usage.cache_read_input_tokens || 0 } : undefined
  };
}

// Scripted stand-in for local testing without a key (AGENT_MOCK=1).
function callMock(mode, msgs) {
  const done = new Set(msgs.filter(m => m.role === 'tool').map(m => m.name));
  const steps = mode === 'gm'
    ? [['get_league_overview', {}], ['get_team_strategy', { team: 'me' }], ['get_team_roster', { team: 'me' }], ['scan_league_needs', {}], ['suggest_trades', { limit: 3 }], ['get_lineup_alerts', {}]]
    : [['get_league_overview', {}]];
  const next = steps.find(([n]) => !done.has(n));
  if (next) return { text: mode === 'gm' ? `Step: ${next[0]}` : '', calls: [{ id: 'mock_' + next[0], name: next[0], args: next[1] }] };
  if (mode === 'gm' && !done.has('evaluate_trade')) {
    const st = JSON.parse(msgs.filter(m => m.name === 'suggest_trades').pop().result);
    const t = st.trades && st.trades[0];
    if (t) return { text: 'Verifying the best trade.', calls: [{ id: 'mock_eval', name: 'evaluate_trade', args: { give: t.user_gives, get: t.user_gets, other_team: t.with_team.replace(' (user)', '') } }] };
  }
  if (mode === 'gm') {
    const st = JSON.parse(msgs.filter(m => m.name === 'suggest_trades').pop().result);
    const ov = JSON.parse(msgs.find(m => m.name === 'get_league_overview').result);
    return { text: '', calls: [{ id: 'mock_submit', name: 'submit_gm_plan', args: {
      goal: ov.type === 'redraft' ? 'Playoff push' : 'Mock goal', verdict: 'Mock verdict from scripted run.', reasoning: 'Scripted mock; no model was called.',
      trades: (st.trades || []).slice(0, 2).map(t => ({ partner: t.with_team, give: t.user_gives, get: t.user_gets, why: (t.reasons || []).join(' '), pitch: 'Mock pitch.' })),
      waiver_adds: [], lineup_fixes: [], watch_list: ['Mock watch item'] } }] };
  }
  return { text: 'Mock answer.', calls: [] };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ version: VERSION, enabled: enabled(), model: process.env.AGENT_MOCK === '1' && !process.env.ANTHROPIC_API_KEY ? 'mock' : model(), tools: [...TOOLS, SUBMIT].map(t => t.name) });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!enabled()) return res.status(503).json({ error: 'The GM agent is not configured yet (no Claude API key on the server).' });
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?').split(',')[0].trim();
  if (limited(ip)) return res.status(429).json({ error: 'Too many requests in a short time. Try again in a few minutes.' });
  try {
    const body = await readBody(req);
    const mode = body.mode === 'gm' ? 'gm' : 'chat';
    const msgs = sanitize(body.messages);
    const ctx = body.context && typeof body.context === 'object' ? body.context : {};
    const system = `${mode === 'gm' ? GM_PROMPT : CHAT_PROMPT}\n\nLoaded league: ${clip(ctx.league, 120)} (${clip(ctx.sport, 10)}, ${clip(ctx.kind, 20)}), week ${clip(ctx.week, 4)}.${ctx.demo ? ' This is the public demo with anonymised names.' : ''}`;
    // only offer tools this copy of the browser app actually implements (an open tab may predate a deploy)
    const allowed = Array.isArray(body.tools) && body.tools.length ? new Set(body.tools.map(String)) : null;
    const out = process.env.ANTHROPIC_API_KEY ? await callClaude(mode, system, msgs, allowed) : callMock(mode, msgs);
    out.version = VERSION;
    const known = new Set([...TOOLS, SUBMIT].filter(t => t === SUBMIT || !allowed || allowed.has(t.name)).map(t => t.name));
    out.calls = (out.calls || []).filter(c => known.has(c.name) && (mode === 'gm' || c.name !== 'submit_gm_plan')).slice(0, 8);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e) });
  }
};
