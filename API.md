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
- `/releases/:project` — 301 redirect to the project's slashed index page, so the pages' relative links resolve
- `/releases/:project/:version` — one rendered release page (the index included, as version "index.html")
- `/ws` — WebSocket (live dashboard updates)

## Core data
- `/api/data` — full DevLogData snapshot (GET)
- `/api/ping` — liveness (GET)
- `/api/daemon-id` — daemon identity `{pid, dataDir, port}` for the data-dir single-writer lock probe (GET)
- `/api/boot` — daemon boot timestamp / freshness (GET)
- `/api/token` — destructive-endpoint token for the dashboard (GET; `{required:false}` unless `DEVLOG_REQUIRE_TOKEN=1`)
- `/api/server/stop` — stop the daemon (POST, audited, token-gated when enabled)
- `/api/server/restart` — self-restart: close both loopback listeners → spawn replacement → exit (POST, audited, token-gated when enabled; `DEVLOG_NO_RESPAWN=1` degrades to stop). A freshness watchdog also triggers this hand-over automatically when the code on disk is newer than the running process and the system is idle (source quiet ≥20s, no mutating request ≥30s, one attempt per source state); disable with `DEVLOG_AUTO_RESTART=0`

## Tag protocol (`routes-tags.ts`)
- `/api/tags` — the tag-processing pipeline (POST)
- `/api/tags/:project` — one project's tags, newest-first, `?limit=` (GET)
- `/api/tag/:id` — delete a tag (DELETE, token-gated when enabled)
- `/api/classify` — classify recent change events (POST)

## Event / session capture (`routes-events.ts`)
- `/api/hook` — hook write hot-path: record an event (POST)
- `/api/session-summary` — roll a session's events into a summary (POST)
- `/api/events/archive` — cold event archive, read on demand only: no params → available months; `?month=YYYY-MM` → that month's archived events, `?project=` filters. Events leaving the hot store (per-project cap eviction, retention cold-prune) are appended to monthly `archive/events-YYYY-MM.jsonl` files (closed months gzipped) instead of being deleted (GET)

## Recall / history (`routes-changes.ts`)
- `/api/file-story` — position memory (#486): one file's timeline — tags whose capture window touched it (`TagEntry.files`, stamped at Stop time) + its change events; `?project=&path=` required (path may be project-relative), `&deep=1` also sweeps the cold event archive (GET)
- `/api/changes` — recent code-edit events (GET)
- `/api/changes/last` — last-N edits (GET)
- `/api/changes/by-id/:id` — one event's full diff (GET)
- `/api/changes/session` — a session's edits (GET)

## Projects (`routes-projects.ts`)
- `/api/project-view/:name` — one project's full profile + its tags/events/plans slices; the dashboard's lazy alternative to `/api/data` (GET)
- `/api/project/:name` — delete a project (DELETE)
- `/api/project/:name/rename` — rename project + folder + memory (POST)
- `/api/cleanup-tombstones` — opt-in sweep of projects whose folder has been missing 30+ days (POST, audited, token-gated when enabled)
- `/api/orphan-projects` — store names with no registry entry + their tag/event/plan counts (GET)
- `/api/cleanup-orphans` — purge store data for an explicit list of orphan names; registered names are refused (POST, audited, token-gated when enabled)

## Plans (`routes-plan.ts`)
- `/api/plan` — register/upsert a doc:plan (POST)
- `/api/plan/:id` — hide a plan (DELETE, token-gated when enabled)
- `/api/plan/:id/upcoming` — defer a plan to «قادمة» or promote it back, body `{ upcoming: boolean }` (POST, token-gated when enabled)
- `/api/changelog/since-last-release` — changelog JSON/markdown (GET)

## Standards / reports (`routes-standards.ts`)
- `/api/projects-summary` — lightweight per-project metadata + counts (GET; avoids full `/api/data`)
- `/api/open-items` — still-open numbered items, the release guard (GET)
- `/api/verdicts/:project` — per-item open/closed verdicts (todos/bugs/security) the dashboard cards render from; same resolvers as open-items (GET)
- `/api/closed-items` — closed items with when/how (GET; `?num=N` for one, else 10 most recent) — powers `-(ask:closed)`
- `/api/standards` — the standards catalog (GET)
- `/api/dep-freshness` — dependency-freshness verdicts (GET)
- `/api/audit` — on-demand OSV audit report, plain text (GET)

## Features / client report (`routes-features.ts`)
- `/api/features` — the current capability inventory (feature tags resolved: updates applied, removed dropped, each attributed to its shipping release) + since-last-release counters for the release nudge (GET; `?project=` or `?cwd=`) — powers `-(ask:features)`
- `/api/features-backfill` — releases not covered by any declared capability, each with its summary + built/update material lines (GET; `?project=` or `?cwd=`) — powers `-(ask:backfill)`
- `/api/retro` — the full problem corpus: every bug/security report, open and closed, with open/close dates, age in days and project-relative touched files, oldest first (GET; `?project=` or `?cwd=`) — powers `-(ask:retro)`
- `/api/client-report` — the client-facing status page as HTML (GET; `?save=1` also persists `<project>/.devlog/client-report.html` and returns the path as JSON)

## Scan / vuln (`routes-scan.ts`)
- `/api/vuln/:project` — run a vuln scan (GET)
- `/api/check-stale/:project` — manifest-mtime staleness check (POST)
- `/api/scan/:project` — full manual rescan (POST)

## Injection (`routes-inject.ts`)
- `/api/inject` — run context injection (GET/POST). Types: SessionStart (primer + project profile), UserPromptSubmit (conditional open-items reminder), PreToolUse (position memory #486: compact file story on the session's first Read of a file with tag history; gated by `preToolUseRead`, no event recorded, no status.md export)
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
- `/api/stack/:project` — parsed DEVLOG_STACK.md + its mtime (GET)
- `/api/stack/:project/regenerate` — explicit regeneration; the only path that overwrites an existing stack file (POST, audited)
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
