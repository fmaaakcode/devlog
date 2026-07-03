# DevLog HTTP API

> Localhost-only (`127.0.0.1`). Every route is wrapped by `guard()` (Host allowlist,
> `Sec-Fetch-Site`/`Origin` checks, `application/json` on mutating methods).
>
> **This file is guarded** by `test/api-routes-documented.test.ts`: it fails if a
> route is added/removed in code without updating this list. Keep it in sync.

## Static / viewer (`routes-static.ts` + server bootstrap)
- `/` — dashboard HTML
- `/stack-map.html` — stack-map viewer
- `/features.html` — features page
- `/assets/:file` — whitelisted static assets
- `/api/file` — read a project file (symlink-safe, text/plain + nosniff)
- `/releases/:project` — a project's releases index
- `/releases/:project/:version` — one rendered release page
- `/ws` — WebSocket (live dashboard updates)

## Core data
- `/api/data` — full DevLogData snapshot (GET)
- `/api/ping` — liveness (GET)
- `/api/boot` — daemon boot timestamp / freshness (GET)
- `/api/token` — destructive-endpoint token for the dashboard (GET; `{required:false}` unless `DEVLOG_REQUIRE_TOKEN=1`)
- `/api/server/stop` — stop the daemon (POST, audited, token-gated when enabled)

## Tag protocol (`routes-tags.ts`)
- `/api/tags` — the tag-processing pipeline (POST)
- `/api/tag/:id` — delete a tag (DELETE)
- `/api/classify` — classify recent change events (POST)

## Event / session capture (`routes-events.ts`)
- `/api/hook` — hook write hot-path: record an event (POST)
- `/api/session-summary` — roll a session's events into a summary (POST)

## Recall / history (`routes-changes.ts`)
- `/api/changes` — recent code-edit events (GET)
- `/api/changes/last` — last-N edits (GET)
- `/api/changes/by-id/:id` — one event's full diff (GET)
- `/api/changes/session` — a session's edits (GET)

## Projects (`routes-projects.ts`)
- `/api/project/:name` — delete a project (DELETE)
- `/api/project/:name/rename` — rename project + folder + memory (POST)

## Plans (`routes-plan.ts`)
- `/api/plan` — register/upsert a doc:plan (POST)
- `/api/plan/:id` — hide a plan (DELETE)
- `/api/changelog/since-last-release` — changelog JSON/markdown (GET)

## Standards / reports (`routes-standards.ts`)
- `/api/projects-summary` — lightweight per-project metadata + counts (GET; avoids full `/api/data`)
- `/api/open-items` — still-open numbered items, the release guard (GET)
- `/api/closed-items` — closed items with when/how (GET; `?num=N` for one, else 10 most recent) — powers `-(ask:closed)`
- `/api/standards` — the standards catalog (GET)
- `/api/dep-freshness` — dependency-freshness verdicts (GET)
- `/api/audit` — on-demand OSV audit report, plain text (GET)

## Scan / vuln (`routes-scan.ts`)
- `/api/vuln/:project` — run a vuln scan (GET)
- `/api/check-stale/:project` — manifest-mtime staleness check (POST)
- `/api/scan/:project` — full manual rescan (POST)

## Injection (`routes-inject.ts`)
- `/api/inject` — run context injection (GET/POST)
- `/api/inject/preview` — preview injection without logging (GET)
- `/api/injections` — injection history (GET)
- `/api/injection/:id` — delete one history entry (DELETE)
- `/api/injection/config` — global + per-project config (GET/POST/DELETE)

## Processes (`routes-processes.ts`)
- `/api/sessions` — active Claude sessions (GET)
- `/api/processes` — a project's tracked processes/orphans (GET)
- `/api/processes/refresh` — force a descendant refresh (POST)
- `/api/kill-pid/:pid` — kill a tracked PID (POST, audited)

## Stack-map / tree (`routes-stack.ts`)
- `/api/stack/:project` — parsed DEVLOG_STACK.md (GET)
- `/api/stack/:project/layout` — saved node positions (GET/POST/DELETE)
- `/api/tree/:project` — project file tree (GET)

## Workspace (`routes-workspace.ts`)
- `/api/worklog` — append a worklog note (POST)
- `/api/ignore` — toggle a `.devignore` entry (POST)

## Misc / utility (`routes-misc.ts`)
- `/api/config` — dashboard feature flags (GET)
- `/api/updates` — upstream tool-update info (GET/POST)
- `/api/event/:id` — delete an event (DELETE)
- `/api/data/clear` — wipe all data (DELETE, X-Confirm)
- `/api/export/:project` — export one project's DEVLOG_STATUS.md (POST)
- `/api/export-all` — export every project's status (POST)
