---
name: devlog-protocol
description: Full DevLog tag-protocol reference. Use when emitting DevLog `-(tag)` markers and you need exact syntax for closures, trackable plans (doc:plan), doc generation (doc:report/analysis/comparison/readme), the standards library (-(ask:rules), -(rule:add)), or the vuln audit (-(audit)). The compact primer is always in context; pull this for the details.
---

# DevLog tag protocol — full reference

Place tags at the **end** of your response. The Stop hook captures them; the dashboard renders them. Don't write tracking files or `queue.json` by hand — tags replace all of that.

Format: `-(tag) content` (case-sensitive). Append `!` after the tag for a breaking change: `-(built!) X`. Multi-line content allowed (up to 2000 chars; 5000 for `about`); the first line is the headline. Write content in the user's language.

## Enforcement (automated)

Three hooks enforce these rules mechanically — you don't need to remember, the harness refuses to end the turn or run the command until you comply:

| Hook | Fires on | Blocks when |
|---|---|---|
| **Stop closure-check** | every turn end | a `-(built)` / `-(refactor)` fuzzy-matches an open `#N` and you didn't emit its closure. Exit 2 → re-respond with the closure. |
| **Stop untagged-guard** | a tag-less turn end | code files were written this session and NOT ONE tag was ever stored for it. Blocks once per session — re-respond ending with tags that describe the work. Mute: `DEVLOG_UNTAGGED_CHECK=0`. |
| **Stop release-guard** | `-(release)` / `-(release:*)` in your response | ANY open item exists (todo, bug, security, plan step). Refuses to persist the release. Close everything first, or `DEVLOG_RELEASE_GUARD=0` to override. |
| **PreToolUse release-guard** | `gh release create` / `git tag -a v*` / `git push --tags` / `npm publish` / `cargo publish` | same rule; also injects the full since-last-release changelog. |

## Tags

| Tag | Use |
|---|---|
| `-(desc)` | The project's STABLE one-line identity ("what is this project?") — never a session summary. Shows under the project name and as the client report's subtitle; re-emit only when the project itself changes. |
| `-(about)` | Long description, replaces previous: plain-language "what it is / how it works" + the concrete stack (language, runtime, frameworks, key libraries, integrations). A technical ID card, not marketing prose. |
| `-(built)` | New code that does **not** map to a plan step |
| `-(refactor)` | Restructure without behavior change |
| `-(update)` | Dependency/library bump |
| `-(bug found)` / `-(bug fix)` | Open + close (close by `#N`) |
| `-(security)` / `-(security:own)` / `-(security:dep)` / `-(security fix)` | Open + close (close by `#N`) |
| `-(todo)` / `-(done) #N` / `-(dropped) #N` | Open a todo, close it, or cancel it |
| `-(upcoming)` | Deferred tier — see «Upcoming» below |
| `-(feature)` / `-(feature update) #N` / `-(feature removed) #N` | Capability inventory — see «Features» below |
| `-(note)` | Observation worth keeping |
| `-(decision)` | Architectural decision + rationale |
| `-(insight)` | Root-cause finding from investigation |
| `-(undo) <text>` | Delete the most recent tag whose content includes `<text>` |
| `-(release) summary` | Release — DevLog auto-detects the bump type **and** computes the number. Force a type with `-(release:patch\|minor\|major)`, or a number with `-(release) vX.Y.Z`. **Only when the user explicitly asks.** |
| `-(doc:TYPE) name\n<markdown>` | Generate `.md` + `.html` (see Doc tags) |

Token-saving: if SessionStart context already shows `desc:` or `about: yes`, don't re-emit them.

## Atomic content (strict)

One concept per tag. Headline-style tags (`todo`, `done`, `dropped`, `bug found`, `bug fix`, `security`, `security fix`, `note`) take a single ≤120-char line.

**Forbidden inside any tag content:** nested bullets (`\n- `), headings (`\n##`), questions (`?`), trailing planning prose. Multiple items → multiple tags. Need to ask the user → ask in the response, never inside a tag. Multi-line *body* is OK only for: `built`, `refactor`, `update`, `decision`, `insight`, `about`, `doc:*`.

## Closure is mandatory

Every open tag has a closure, emitted in the **same response** as the work.

**Always close by `#N` — never copy the full text.** Re-emitting wording wastes tokens and risks a byte-level mismatch that leaves the item open forever. `#N` numbers arrive in the SessionStart context and the dashboard; type `?open` in a prompt for full text, or emit `-(ask:open)` yourself to pull the live open list (bugs/todos/security/plan-steps) mid-response before closing — so you never close a stale or wrong number. To verify an item is *already* closed (and see when/how it was closed), emit `-(ask:closed) #N` (or bare `-(ask:closed)` for the recent closures) instead of grepping `.devlog/` files or re-investigating finished work.

| Open | Close |
|---|---|
| `-(todo) X` | `-(done) #N` / `-(dropped) #N` |
| `-(bug found) X` | `-(bug fix) #N` |
| `-(security[:own/:dep]) X` | `-(security fix) #N` |
| `[ ] step` in `doc:plan` | `-(done) #N` |
| all `[ ]` under `### Pn` | `-(done) Pn` |

**Opened AND finished in the SAME response** (a `-(bug found)` plus its fix, a `-(todo)` done immediately): emit the closer with **no number at all** — DevLog pairs it with the single work item opened in that response and echoes `🔗` with the real `#N`. Never guess the next `#N`: numbers are assigned only after the response ends, and a guessed number is rejected (or, when it matches nothing and exactly one item was opened this response, auto-paired with a corrective echo). **Text closure is permitted ONLY** when injection is off. Otherwise use `#N`.

**Verify before closing.** "Verified" = observed evidence in this conversation (a passing test in the transcript, a successful tool result, explicit user confirmation). Reading code and concluding "it should work" is **not** verification. If you can't verify this turn, leave it open and emit a `-(note)` stating what's needed. The Stop hook cross-checks closures against the session trace: a test run that **failed**, or one that **predates your last code edit**, does not count as evidence — run the suite again, after the change, and see it pass.

`-(built)` is not a closure — if work maps to a plan step, also emit `-(done) #N`. Don't fake-close security tags: if you reviewed but didn't fix, say so; don't emit `-(security fix)`.

## Upcoming — the deferred tier («قادمة»)

Two tiers of open work: **committed** (todo/bug/plan-step — the guard enforces closure and blocks releases) and **upcoming** (recorded ambition — visible everywhere, enforced nowhere). Use upcoming for ideas worth keeping that nobody is committing to now, instead of parking them outside DevLog.

| Command | Effect |
|---|---|
| `-(upcoming) X` | Create a deferred item directly (numbered like a todo) |
| `-(upcoming) #N` | Defer the open todo/bug `#N` in place — same number, history intact |
| `-(todo) #N` | Promote upcoming `#N` back to a committed todo |
| `-(done) #N` / `-(bug fix) #N` | Close an upcoming item directly — no promotion needed |

Rules: a `#N` that is an open **plan step** defers/promotes the whole plan. **Security items are never deferrable** — fix them or leave them open. Upcoming items don't block `-(release)`, don't trigger the closure-check, and don't count in "Open now"; they appear as one awareness line at SessionStart (toggle: لوحة الحقن → «سطر القادمة»), in the القادمة tabs on the dashboard's tasks/plans cards, in `?open` / `-(ask:open)` under their own section, and each release page snapshots them in a «قادم» section.

## Features — the capability inventory («قدرات»)

Work tags record developer-language deltas; clients ask in capability language
("does the system support X?"). `-(feature)` declares ONE client-visible
capability, in the user's language, **when it lands** — not per code step.
Features are numbered like todos but are **facts, not debt**: they never block a
release, never trigger closure checks, and aren't part of `ask:open`.

| Command | Effect |
|---|---|
| `-(feature) <one client-language line>` | Declare a capability (numbered) |
| `-(feature update) #N <new text>` | The capability evolved — new wording |
| `-(feature removed) #N` | The capability no longer exists |
| `-(ask:features)` | Pull the CURRENT inventory (updates applied, removed dropped, each attributed to the release that shipped it) — served in-turn, not logged |
| `-(feature) [vX.Y.Z] <line>` | Backfill: declare a capability attributed to the PAST release `vX.Y.Z` that shipped it — never satisfies the release nudge and never appears on another release's page |
| `-(ask:backfill)` | Pull the releases NO capability is attributed to, each with its summary + work material — draft one capability line per release, get the user's approval, then declare each with the `[vX.Y.Z]` marker (served in-turn, not logged) |

The current list = every feature not removed; each is attributed to the first
release cut after it landed («منذ vX.Y.Z» / unreleased) — unless its text opens
with an explicit `[vX.Y.Z]` marker, which pins it to that past release (the
backfill path for pre-feature-era history). It renders as the
«قدرات جديدة» section of release pages, the «قدرات» header chip on the
dashboard, and the backbone of the client report (`/api/client-report` — the
dashboard's «تقرير العميل» button; open work appears there as a count only and
security as a reassurance line, never details).

**Soft release nudge**: a `-(release)` with work tags (`built`/`update`) accrued
since the last release but ZERO new `-(feature)` gets ONE reminder (the release
is held back once); declare the missed capability + re-emit the release, or
re-emit as-is for a purely technical release. Mute with `DEVLOG_FEATURE_NUDGE=0`.

## Retrospective — the problem corpus (`ask:retro`)

`-(ask:retro)` pulls EVERY problem report of the project — bugs and security,
open and closed — one compact line each: `#N [kind] opened→closed (age) text —
files`, oldest first, sourced from the tags store (never capped or rotated, so
it reaches the project's first day). Served in-turn like the other pull
commands; never a logged tag.

Its purpose is analysis, not bookkeeping: cluster the recurrences yourself
("which problems repeat, which files keep appearing") and codify a confirmed
pattern with `-(rule:add)` (make it enforceable) or `-(insight)` (record the
root cause). DevLog serves the data; the clustering is your language work.

## Deep study — the project report (`ask:study`)

`-(ask:study)` pulls the deep-study corpus of the project: **whole-history
aggregates** (tag/session counts, the monthly opened/closed/released trend,
time-to-close medians, open-now state, release hygiene, plan discipline,
most-broken files, capability coverage, and a work-rhythm behavior profile —
peak hours, weekday spread, streaks/gaps and session shapes, derived from tag
timestamps which reach the first day uncapped) plus a **narrative delta** (releases,
problem reports touched, decisions/insights, longest-lived items closed, work
counts) and, when a previous study exists, its **conclusions digest**. Served
in-turn like the other pull commands; never a logged tag.

Studies are RANGES like releases: the corpus window covers everything since the
previous stored study (the watermark); the first study of a project is
FOUNDATIONAL and covers its entire history. Aggregates are always recomputed
over the full history — they stay compact — so every report keeps a
first-day-to-today spine while the narrative never re-serves a studied period.

Your work after the pull: analyze discipline, recurring problems, project
trajectory and user workflow, then store the report as
`-(doc:report) study-YYYY-MM-DD <title>` — the `study-` (or `دراسة-`) name
prefix is what makes the report the NEXT study's watermark. End it with a
«الخلاصة» section: that section is the digest the next study builds on
(confirm each earlier pattern held, or declare it broken — never re-derive a
studied year). Stored studies appear in the dashboard's «دراسات» header chip.

## Doc tags

Write only markdown; the server wraps it in a template and saves `.md` + `.html` under `<project>/.devlog/docs/`. Types: `doc:report`, `doc:analysis`, `doc:plan`, `doc:comparison`, `doc:readme`, `doc:update` (appends to an existing doc by name). First line after the tag = document name (becomes the file slug).

```
-(doc:report) my-report-name
# Heading
body...
```

Markdown subset: headings `#`–`######`, lists, GFM tables, fenced + inline code, `**bold**`, `*italic*`, links, callouts `> [!note|warning|info|tip|important]`, `---`, GFM checkboxes. Limits: 50 KB/doc; `<script>`/`on*`/`javascript:`/`data:` stripped. Never write a literal `- (something)` line in a body — it looks like a tag; use `*` for bullets if a paren follows.

## Plans (`doc:plan`)

GFM checkboxes inside a `doc:plan` become trackable steps. Each `### Pn — ...` heading (or `### Pn.m`) tags the checkboxes under it with a phase code. Any non-phase `##`/`###` heading clears the active phase.

**Closing steps — two modes:**
1. **Exact text:** `-(done) Round-robin scheduler` — closes one step (whitespace/backticks normalized, case ignored).
2. **Phase code:** `-(done) P3` — closes every open `[ ]` under `### P3 — ...`. Content must contain exactly one `Pn(.m)?` token.

`-(dropped)` removes the line entirely (cancellation), and accepts both modes. Re-emitting `-(doc:plan)` with the same name **updates** the plan, preserving completion state of existing steps.

**When to write one:** as soon as the project crosses ~3 features or ~5 builts without an existing plan. Small plans (5–10 steps) beat no plan. Skip for bug fixes or one-off edits.

## Standards library

A reusable rules library lives at `~/.claude/standards/`, organized by axis (`languages/`, `platforms/`, `app-types/`, `cross-cutting/`). Before writing code, map the task to its categories and pull them. Replies come back **in the same turn** (served via the Stop hook's stderr). These commands are NOT logged as tags.

| Command | Use |
|---|---|
| `-(ask:rules) <cat> [<cat>…]` | Pull one or more categories' rules |
| `-(rule:add) <cat>`<br>`<rule text>` | Append a permanent rule (append-only, dedup'd) |
| `-(rule:new) <axis>/<cat>` | Create a new category |
| `-(rules:list)` | Show the full catalog |
| `-(rule:rm) <cat> #N` | Remove rule #N from a category |

Available category names are injected at SessionStart under "معايير متاحة (Standards)". For a rich reference standard (design tokens, tables), write the file directly at `~/.claude/standards/<axis>/<category>.md`.

## Vuln audit

`-(audit)` — a full known-vulnerability report for the project's dependencies (direct + transitive, every ecosystem via OSV.dev natively). Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(audit)` | Scan the whole dependency tree |
| `-(audit) <package>` | Restrict to one package |

To dismiss an inapplicable advisory, record it (don't delete from the lockfile): Rust → `audit.toml` `[advisories] ignore = [...]`; any ecosystem → `.devlog/vuln-ignore` (one advisory id per line, or `pkg:<name>`). Always document why with a per-entry comment.

## Library advisor (`ask:lib`)

Before **adding a new dependency**, ask DevLog instead of researching versions yourself (you have no network; the server does). Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(ask:lib) astro zod` | The exact version to install for each name (up to 8) |
| `-(ask:lib) crates:serde pypi:requests` | Prefix overrides the project's ecosystem (`npm:`/`pypi:`/`crates:`) |

The suggestion is the newest **stable** release **≥7 days old** (the dependency-maturity rule) that **OSV certifies clean** — vulnerable candidates are stepped past with the reason shown. Guarantees: never a pre-release, never a version younger than 7 days, never a knowingly vulnerable version (a package with no clean matured release is reported, not recommended), and never a near-miss name guess — an unknown name is refused (typo-squatting). If OSV doesn't answer, the maturity pick is flagged as carrying no security certificate. Then install with the returned command — don't substitute blind `@latest`.

**The install gate enforces this.** A PreToolUse hook intercepts package-add commands (`bun|pnpm|yarn add`, `npm i`, `cargo add`, `pip|uv install`) before they run: a **blind** install (no pinned version, or a floating `@latest`-style tag) is blocked with the advisor's pick in the block message — re-issue with the pin. A **pinned** install that disagrees with the advisor gets a one-time advisory block; re-issuing the identical command passes (a pin is a deliberate choice, possibly the user's explicit order). Unknown names, private registries, and a down server all fail open — the vuln scan and the next-prompt security alert are the backstops. `DEVLOG_INSTALL_GATE=strict` flips that: any verification failure (daemon down, network error, unknown name, OSV silent) **blocks** instead, with the same verbatim-re-issue override. Disable with `DEVLOG_INSTALL_GATE=0`.

## The deps explainer (`lib` / `ask:deps`)

Every dependency raises two questions: *what is it* (the registry's official one-liner — DevLog captures it for free from the freshness lookup) and *why is it in THIS project* — which only the project's own log can answer. That second line is yours to record:

| Command | Use |
|---|---|
| `-(lib) zod — التحقق من حمولات الويبهوك` | STORED: one-line purpose in the user's language, emitted right after installing (the ask:lib answer reminds you). Re-emit the same name to update — latest wins. |
| `-(ask:deps)` | Ephemeral pull: the full inventory (purpose + official description + vuln/outdated status), uncovered libraries first, with a coverage count |

Backfill: when `ask:deps` lists libraries with no purpose, draft one line each, get the **user's approval**, then emit one `-(lib)` per library. The user browses the same data from the dashboard: the `dependencies` button opens `/deps.html` (hover popup unchanged — quick vuln glance only).

## Recall (`ask:search`)

The log answers back: lexical search (BM25, Arabic+English normalization) over every stored tag — decisions, insights, notes, builds, closed bugs *with their fixes*. Prefer it over re-deriving a past decision or re-investigating a solved problem. Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(ask:search) why sse over websocket` | Best-matching stored tags of THIS project, each with `[tag] #N date — snippet` |
| `-(ask:search) all: oembed blocked` | Widen to every tracked project (cross-project recurrence) |

Matching is lexical, not semantic — use the vocabulary the log was written in (an English query won't match an Arabic-only tag). Auto-recall rides on it: when a fresh `-(bug found)` resembles a historically closed bug (enough shared terms), the next prompt's injection carries a one-shot `🧠` hint with the old fix's `#N`, close date and files — check it with `-(ask:closed) #N` before solving from scratch.

## Releases & GitHub — split roles

**Releasing (the DevLog tag) is the developer's job; git/GitHub is the specialist's.**

- **You (the developer), only when the user asks to ship:** close every open `#N`, then just emit `-(release) <one-line reason>`. **DevLog auto-detects the bump type** (breaking → major, feature → minor, otherwise patch) and **computes the version** from the project's highest current version (never regresses), bumps the manifests, and writes the release HTML + changelog under `.devlog/releases/`. You don't pick a type or a number. To *force* a type, use `-(release:patch|minor|major)` (DevLog still computes the number, and **warns — never overrides —** if your type is below the evidence). To *force* a number, use `-(release) vX.Y.Z — summary`. Don't hand-edit `version` fields.

  **Exception — manual version mode:** when something else owns the manifests' version format (another plugin, a monorepo tool, a custom release pipeline) and DevLog's writer would conflict with it, hand-edit the manifests to the chosen version FIRST, then emit `-(release) vX.Y.Z — summary` with the **byte-identical** number in the same response. The version writer withdraws on equality — file already at the tag's version = no write at all, not even a same-content rewrite — so formatting stays untouched while the release page, changelog and record are still produced. The numbers must match exactly: a manifest at 1.5.0 under a `-(release) v1.6.0` tag gets bumped to 1.6.0 (or rejected as a downgrade in the opposite direction).

  The no-op guarantee covers every format the writer understands: `X.Y.Z`, `X.Y.Z-prerelease`, calver (`2026.7.20`), build metadata (`2.0.0+build.7`) and four-or-more-part versions (`2.0.0.4`) — all verified byte-untouched under a byte-identical tag. Build metadata additionally never triggers a write on its own: it carries no semver precedence, so a bare `v2.0.0` tag over a `2.0.0+build.7` manifest withdraws instead of stripping the metadata.
- **The GitHub specialist, separately:** reads the DevLog changelog/release file to see what changed, compares repos, reviews for leaked secrets, then commits + pushes both repos and tags git to match the DevLog version — **no version decisions on the git side.**

Still not yours: `git push` / `git commit` / any GitHub CLI — the `-(release:*)` tag is a DevLog signal, not a git command.
