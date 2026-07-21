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
- `/deps.html` — the deps explainer page: every manifest library with its recorded purpose line, official registry description and vuln/outdated status (opened from the dashboard's dependencies button; `?project=`)
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
- `/api/recall` — recall search behind `-(ask:search)` (GET, `?q=..&cwd=..&all=1&limit=8`): BM25 with Arabic/English normalization over the stored tags (`recall.ts`), scoped to the cwd's project unless `all=1` widens it to every project. Read-only
- `/api/tag/:id` — delete a tag (DELETE, token-gated when enabled)
- `/api/undone` — tags/plan-steps removed by `-(undo)`, read on demand: no params → available months; `?month=YYYY-MM` → that month's undone rows newest-first, `?project=` filters. `-(undo)` archives the row to `archive/undone-YYYY-MM.jsonl` before removing it (and refuses to remove it if that write fails), so each record carries the original entry verbatim — restoring is a re-POST to `/api/tags` (GET)
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
- `/api/changes/session` — a session's edits + its stored-tag count (`tagCount`, feeds the Stop hook's untagged-session guard) (GET)

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
- `/api/deps` — the deps-explainer payload: every manifest library annotated with its recorded purpose (`lib` tags, latest per name wins), cached registry description and vuln/outdated status, uncovered-first (GET; `?project=` or `?cwd=`) — powers `-(ask:deps)` and `/deps.html`
- `/api/retro` — the full problem corpus: every bug/security report, open and closed, with open/close dates, age in days and project-relative touched files, oldest first, plus `fragile` (files recurring across reports) and `testGap` (fixes closed without their session touching a test — #585) (GET; `?project=` or `?cwd=`) — powers `-(ask:retro)`
- `/api/study` — the deep-study corpus: whole-history aggregates (monthly trend, time-to-close medians, release hygiene, fragile files, the regression-test gap, capability coverage, work-rhythm behavior profile from tag timestamps) + narrative delta since the previous stored study + that study's conclusions digest (GET; `?project=` or `?cwd=`) — powers `-(ask:study)`
- `/api/docs` — the project's stored-docs index (doc:report/analysis/…; plans excluded) from `.devlog/docs/index.json` (GET; `?project=` or `?cwd=`) — powers the dashboard's «دراسات» chip
- `/api/doc-page` — one rendered doc page as HTML from `<project>/.devlog/docs/<slug>.html`; slug validated and path-checked against the docs dir (GET; `?project=`/`?cwd=` + `&slug=`)
- `/api/client-report` — the client-facing status page as HTML (GET; `?save=1` also persists `<project>/.devlog/client-report.html` and returns the path as JSON)

## Scan / vuln (`routes-scan.ts`)
- `/api/vuln/:project` — run a vuln scan (GET)
- `/api/lib-advice` — version advisor behind `-(ask:lib)` (GET, `?cwd=..&names=a,b,c`): per name, the newest stable release ≥7 days old that OSV certifies clean (`lib-advisor.ts`); vulnerable matured candidates are stepped past (bounded), unknown names refused exactly (no near-miss guesses), `npm:`/`pypi:`/`crates:` prefix overrides the cwd project's ecosystem. Read-only — no tags, no profile writes
- `/api/install-override` — conscious override of a KNOWN-vulnerable pinned install (#630) (POST, `{cwd, pins:[{eco,name,version,text}]}`): the install gate's ack pass-through posts here so the accepted risk lands as an open numbered `security` tag immediately (scanner-format text → the sweep dedupes/supersedes/auto-closes it like its own). Unknown cwd → `ok:false` (fail-open)
- `/api/check-stale/:project` — manifest-mtime staleness check (POST)
- `/api/scan/:project` — full manual rescan (POST)

## Injection (`routes-inject.ts`)
- `/api/inject` — run context injection (GET/POST). Types: SessionStart (primer + project profile), UserPromptSubmit (conditional open-items reminder + mid-session security alert: a vuln-scan `security` tag opened after the session's last injection and rated high/critical or `danger` is delivered at the next prompt, once per tag, bypassing the `userPromptSubmit` toggle), PreToolUse (position memory #486: compact file story on the session's first Read of a file with tag history; gated by `preToolUseRead`, no event recorded, no status.md export). The response may carry a top-level `systemMessage` — the ONE channel Claude Code shows the user for an exit-0 hook (stderr is discarded), so every "your tooling is broken" alert merges into it (`inject-warnings.ts`): a stale daemon (code on disk newer than boot, SessionStart), transcript-shape drift against parse-tags' assumptions (#582, SessionStart + UserPromptSubmit, once per session), and fresh log-integrity damage (#583, SessionStart, last 7 days, pointing at `doctor`)
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
- `/api/project-export/:project` — portable bundle of ONE project's full history (profile + tags + plans + events + worklog + monthly archive) as a JSON download; how a log follows its code to another machine (GET)
- `/api/project-import` — merge a bundle from another machine: unknown project registers as-is; an existing one merges with id-dedup (idempotent re-import), `#N` renumbered past the local high-water mark, `relatedTo` remapped, profile fill-empty, pre-import `.bak` backups (POST)
