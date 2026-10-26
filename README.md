# Sleeper Fantasy Dashboard

A live analytics dashboard for Sleeper fantasy football and basketball leagues. Type any Sleeper username and it loads that person's leagues, rosters, matchups, alerts and trade ideas. No account or login needed.

**Live site:** https://sleeper-dashboard-nine.vercel.app

## What this project shows

- **API integration across three sources:** Sleeper (leagues, rosters, stats, projections), FantasyCalc (market trade values) and ESPN (news), combined into one view.
- **Correct domain logic:** fantasy points are recomputed from each league's own scoring rules and match Sleeper's official scores exactly.
- **Serverless backend:** Vercel functions slim Sleeper's ~15 MB player database down to what the app needs and cache it at the edge.
- **Decision tools, not just stats:** a lineup optimizer, a trade engine that values players and draft picks and estimates whether an offer gets accepted, and per-league strategy views.

## Features

| Tab | What it does |
|---|---|
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
        ├─ players.js  -> slimmed Sleeper player database
        ├─ values.js   -> FantasyCalc trade values for players and picks
        └─ news.js     -> ESPN headlines
```

**Stack:** JavaScript (no framework), HTML/CSS, Vercel serverless functions, public REST APIs.

## Run it locally

```
npm i -g vercel
vercel dev
```

Then open http://localhost:3000 and enter a Sleeper username.
