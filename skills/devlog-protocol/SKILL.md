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
| **Stop release-guard** | `-(release)` / `-(release:*)` in your response | ANY open item exists (todo, bug, security, plan step). Refuses to persist the release. Close everything first, or `DEVLOG_RELEASE_GUARD=0` to override. |
| **PreToolUse release-guard** | `gh release create` / `git tag -a v*` / `git push --tags` / `npm publish` / `cargo publish` | same rule; also injects the full since-last-release changelog. |

## Tags

| Tag | Use |
|---|---|
| `-(desc)` | One-line project description (first time only) |
| `-(about)` | Long multi-line project description. Replaces previous. |
| `-(built)` | New code that does **not** map to a plan step |
| `-(refactor)` | Restructure without behavior change |
| `-(update)` | Dependency/library bump |
| `-(bug found)` / `-(bug fix)` | Open + close (close by `#N`) |
| `-(security)` / `-(security:own)` / `-(security:dep)` / `-(security fix)` | Open + close (close by `#N`) |
| `-(todo)` / `-(done) #N` / `-(dropped) #N` | Open a todo, close it, or cancel it |
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

**Always close by `#N` — never copy the full text.** Re-emitting wording wastes tokens and risks a byte-level mismatch that leaves the item open forever. `#N` numbers arrive in the SessionStart context and the dashboard; type `?open` in a prompt for full text.

| Open | Close |
|---|---|
| `-(todo) X` | `-(done) #N` / `-(dropped) #N` |
| `-(bug found) X` | `-(bug fix) #N` |
| `-(security[:own/:dep]) X` | `-(security fix) #N` |
| `[ ] step` in `doc:plan` | `-(done) #N` |
| all `[ ]` under `### Pn` | `-(done) Pn` |

**Text closure is permitted ONLY** when injection is off, or when closing an item created earlier in the *same* response before its `#N` was assigned. Otherwise use `#N`.

**Verify before closing.** "Verified" = observed evidence in this conversation (a passing test in the transcript, a successful tool result, explicit user confirmation). Reading code and concluding "it should work" is **not** verification. If you can't verify this turn, leave it open and emit a `-(note)` stating what's needed.

`-(built)` is not a closure — if work maps to a plan step, also emit `-(done) #N`. Don't fake-close security tags: if you reviewed but didn't fix, say so; don't emit `-(security fix)`.

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

## Releases & GitHub — split roles

**Releasing (the DevLog tag) is the developer's job; git/GitHub is the specialist's.**

- **You (the developer), only when the user asks to ship:** close every open `#N`, then just emit `-(release) <one-line reason>`. **DevLog auto-detects the bump type** (breaking → major, feature → minor, otherwise patch) and **computes the version** from the project's highest current version (never regresses), bumps the manifests, and writes the release HTML + changelog under `.devlog/releases/`. You don't pick a type or a number. To *force* a type, use `-(release:patch|minor|major)` (DevLog still computes the number, and **warns — never overrides —** if your type is below the evidence). To *force* a number, use `-(release) vX.Y.Z — summary`. Don't hand-edit `version` fields.
- **The GitHub specialist, separately:** reads the DevLog changelog/release file to see what changed, compares repos, reviews for leaked secrets, then commits + pushes both repos and tags git to match the DevLog version — **no version decisions on the git side.**

Still not yours: `git push` / `git commit` / any GitHub CLI — the `-(release:*)` tag is a DevLog signal, not a git command.
