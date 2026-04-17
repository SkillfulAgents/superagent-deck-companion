# SuperAgent Stream Deck Companion

Ghost-light background companion that turns an **Elgato Stream Deck Neo** into a live control surface for [SuperAgent](https://github.com/SkillfulAgents/SuperAgent). Each LCD key mirrors one agent: current status, activity (browser use / computer use / compacting / awaiting input), token/cost sparkline, and a deep-link jump to that agent's latest session.

Works as a **dedicated controller mode** — it takes over the device from Elgato's official Stream Deck app. Close that app before running this one.

## Requirements

- Node.js 20+
- Elgato Stream Deck Neo (other Stream Deck models are not supported yet)
- A local [SuperAgent](https://github.com/SkillfulAgents/SuperAgent) instance (any port in `49000-49099`; auto-discovered)

## Quick start

```bash
npm install
npm run dev
```

The companion will:

1. Probe `127.0.0.1:49000-49099` in parallel (≤ 400 ms) for SuperAgent's local API.
2. Claim the Stream Deck Neo via HID.
3. Start the 10 fps render loop and subscribe to agent / session SSE streams.

If SuperAgent isn't running yet, the companion keeps retrying with exponential backoff — start SuperAgent any time and it'll pick up automatically.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run directly with `tsx`, production protocol (`superagent://`). |
| `npm run dev:dev-protocol` | Same, but uses the dev protocol (`superagent-dev://`). |
| `npm run build` | Bundle to `dist/` via `tsup`. |
| `npm start` | Run the bundled build. |
| `npm run preview` | Render all button states to `preview/*.png` **without any hardware** — handy for iterating on visuals. |
| `npm run diagnose` | Print detected Stream Deck devices + resolved SuperAgent API. |
| `npm run bundle:mac` / `bundle:win` / `bundle:all` | Build platform-specific distributable bundles under `bundle/`. |

## Controls

| Input | Action |
| --- | --- |
| Any LCD key (agent) | Open that agent in SuperAgent; if the agent is awaiting input, jump straight to that session. |
| Left / right RGB keys | Page through agents (8 per page). |
| Unplug / replug device | Auto-reconnects with backoff. |
| `SIGINT` / `SIGTERM` / crash | Graceful shutdown: flush persisted UI state, clear device screen, close HID. |

## Configuration

Runtime config is resolved in this order (first match wins):

1. Env: `SUPERAGENT_API_URL`, `SUPERAGENT_PORT`, `SUPERAGENT_PROTOCOL`
2. `~/.superagent-deck-companion/companion.config.json`
3. Parallel port scan on `127.0.0.1:49000-49099`

UI state (focused agent, current page) is persisted to `~/.superagent-deck-companion/state.json` and restored on restart.

## Architecture

```
src/
├── index.ts                      # Entry point
├── core/app.ts                   # Orchestration, render loop, deep links
├── devices/
│   ├── device.ts                 # CompanionDevice interface
│   └── elgato-stream-deck-neo-device.ts
├── agent-monitor.ts              # SuperAgent agent list + SSE (watchdog + backoff)
├── session-activity-monitor.ts   # Per-session SSE stream (browser/computer/compacting)
├── usage-monitor.ts              # Token/cost sparkline data
├── button-renderer.ts            # SVG → PNG via sharp, with LRU raster cache
├── config.ts                     # Parallel API discovery
├── state-store.ts                # Debounced persistence
├── platform-utils.ts             # Deep link launchers (execFile, no shell)
└── preview.ts                    # Headless design tool
```

Device access is fully abstracted behind `CompanionDevice` — adding support for another Stream Deck model is a matter of implementing that interface.

## Known limitations

- Only Stream Deck Neo is implemented.
- Sharing the device with Elgato's official app is not supported; close it first.
- Production signing / notarization for the bundled macOS / Windows packages is not wired up yet.
