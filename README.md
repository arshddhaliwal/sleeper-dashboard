# Sleeper Fantasy Dashboard

A live analytics dashboard for Sleeper fantasy football and basketball leagues. Type any Sleeper username and it loads that person's leagues, rosters, matchups, alerts and trade ideas. No account or login needed.

**Live demo (no login needed):** https://sleeper-dashboard-nine.vercel.app/?demo=1
**Try the AI agent:** https://sleeper-dashboard-nine.vercel.app/?demo=1#gm
The demo loads a real dynasty league with every team and manager name hidden. To see your own leagues, open https://sleeper-dashboard-nine.vercel.app and enter your Sleeper username.

## What this project shows

- **An autonomous AI agent (GM Agent):** pick a goal and a Claude agent plans in steps, calling the app's own functions as tools (standings, league needs, rosters, strategy model, trade engine, trade calculator, league history, lineup checks). It verifies every trade it proposes with the trade calculator, revises ones the other team would reject, and returns a structured plan. Redraft leagues are never offered a rebuild.

- **A start/sit model that sees what projections can't:** every player's projection is adjusted for how the opposing defense has actually done against his position *in that league's scoring* (graded A–F from the real weekly stat lines), the forecast at kickoff (wind, rain, snow, cold from Open-Meteo), the betting line (implied team total, game script), his injury tag and injured starters on the defense he faces — with every factor shown, a floor/ceiling band, recommended swaps and coin flips. The GM agent uses the same model to answer "X or Y?".

- **API integration across four sources:** Sleeper (leagues, rosters, stats, projections), FantasyCalc (market trade values), ESPN (news, kickoff times, lines) and Open-Meteo (stadium forecasts), combined into one view.
- **Correct domain logic:** fantasy points are recomputed from each league's own scoring rules and match Sleeper's official scores exactly.
- **Serverless backend:** Vercel functions slim Sleeper's ~15 MB player database down to what the app needs and cache it at the edge.
- **Decision tools, not just stats:** a lineup optimizer, a trade engine that values players and draft picks and estimates whether an offer gets accepted, and per-league strategy views.

## Features

| Tab | What it does |
|---|---|
| This week | The home screen: a START / SIT / COIN FLIP call for every lineup slot with one plain-English reason, tap for the full breakdown |
| GM Agent | Autonomous Claude agent: goal → multi-step plan with verified trades, waiver moves and lineup fixes, plus follow-up chat |
| Start/Sit (under More) | A field view of the expected 22 (ESPN formation depth charts, your players and injuries marked), game-environment cards (weather, lines, defensive injuries) and a 32-team defense-vs-position heatmap in the league's scoring |
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
        ├─ defense.js  -> per-week stat lines allowed by each defense to each position (scored client-side)
        ├─ games.js    -> kickoff, indoor/outdoor, DraftKings line via ESPN + Open-Meteo forecast at kickoff
        ├─ depth.js    -> ESPN formation depth charts for all 32 teams (expected offense incl. O-line, base defense)
        ├─ values.js   -> FantasyCalc trade values for players and picks
        └─ news.js     -> ESPN headlines
```

**How the agent works:** the model runs server-side in `api/agent.js`, one turn at a time. Tool calls come back to the browser, which runs them in `agent.js` against the league data the app already computed (so the agent and the UI share one source of truth), then sends the results back. A final `submit_gm_plan` tool returns structured output, and each proposed trade is re-checked client-side before it is shown. Prompt caching keeps long multi-turn runs cheap; a typical run is 4–6 model turns and 10–15 tool calls in about 20 seconds.

**How start/sit works:** `api/defense.js` sums the raw stat lines (yards, TDs, receptions, bonuses…) of every QB/RB/WR/TE/K each defense faced, week by week. Scoring is linear, so the browser can apply any league's scoring rules to those sums and get exactly the points that league would have awarded, then grades all 32 defenses per position (60% season / 40% last three games). `startsit.js` multiplies each player's blended projection by the matchup, weather, line, injury and home factors and re-optimises the lineup; `analyze_start_sit` exposes the same numbers to the GM agent.

**Stack:** JavaScript (no framework), HTML/CSS, Vercel serverless functions, Claude API (tool use), public REST APIs.

## Run it locally

```
npm i -g vercel
vercel dev
```

Then open http://localhost:3000 and enter a Sleeper username.
