# Sleeper Fantasy Dashboard

A live analytics dashboard for Sleeper fantasy football and basketball leagues. Type any Sleeper username and it loads that person's leagues, rosters, matchups, alerts and trade ideas. No account or login needed.

**Live demo (no login needed):** https://sleeper-dashboard-nine.vercel.app/?demo=1
**Try the AI agent:** https://sleeper-dashboard-nine.vercel.app/?demo=1#gm
The demo loads a real dynasty league with every team and manager name hidden. To see your own leagues, open https://sleeper-dashboard-nine.vercel.app and enter your Sleeper username.

## What this project shows

- **An autonomous AI agent (GM Agent):** pick a goal and a Claude agent plans in steps, calling the app's own functions as tools (standings, league needs, rosters, strategy model, trade engine, trade calculator, league history, lineup checks). It verifies every trade it proposes with the trade calculator, revises ones the other team would reject, and returns a structured plan. Redraft leagues are never offered a rebuild.

- **API integration across three sources:** Sleeper (leagues, rosters, stats, projections), FantasyCalc (market trade values) and ESPN (news), combined into one view.
- **Correct domain logic:** fantasy points are recomputed from each league's own scoring rules and match Sleeper's official scores exactly.
- **Serverless backend:** Vercel functions slim Sleeper's ~15 MB player database down to what the app needs and cache it at the edge.
- **Decision tools, not just stats:** a lineup optimizer, a trade engine that values players and draft picks and estimates whether an offer gets accepted, and per-league strategy views.

## Features

| Tab | What it does |
|---|---|
| GM Agent | Autonomous Claude agent: goal → multi-step plan with verified trades, waiver moves and lineup fixes, plus follow-up chat |
| Overview | Standings, projected draft order and league summary |
| Alerts | Injured or bye-week starters, empty lineup spots, injury news |
| My Team / Teams | Rosters with points in the league's scoring |
| Matchups | Live weekly matchups |
| News | Latest ESPN headlines matched to rostered players |
| Trade Finder | Suggested trades based on each team's needs and market values |
| Trade Calculator | Checks any offer, including draft picks |
| Strategy / History | Contend-or-rebuild view and multi-season player and pick timelines |

Settings like keepers are saved only in the viewer's browser.

## How it works

```
Browser (index.html + app.js and feature modules)
   ├─ Sleeper public API  (leagues, rosters, matchups, stats, projections)
   └─ Vercel serverless functions (api/)
        ├─ agent.js    -> Claude tool-use loop (key, prompts, tool schemas, prompt caching)
        ├─ players.js  -> slimmed Sleeper player database
        ├─ values.js   -> FantasyCalc trade values for players and picks
        └─ news.js     -> ESPN headlines
```

**How the agent works:** the model runs server-side in `api/agent.js`, one turn at a time. Tool calls come back to the browser, which runs them in `agent.js` against the league data the app already computed (so the agent and the UI share one source of truth), then sends the results back. A final `submit_gm_plan` tool returns structured output, and each proposed trade is re-checked client-side before it is shown. Prompt caching keeps long multi-turn runs cheap; a typical run is 4–6 model turns and 10–15 tool calls in about 20 seconds.

**Stack:** JavaScript (no framework), HTML/CSS, Vercel serverless functions, Claude API (tool use), public REST APIs.

## Run it locally

```
npm i -g vercel
vercel dev
```

Then open http://localhost:3000 and enter a Sleeper username.
