---
name: devlog-protocol
description: DevLog tag-protocol reference — an index; each topic lives in its own file under reference/, read only the one you need. Use when you need exact syntax for closures, releases, trackable plans (doc:plan), doc tags, features, the standards library (-(ask:rules), -(rule:add)), dependencies (-(ask:lib), -(audit)), or the ask:* pull commands. The compact primer is always in context; this is for the details.
---

# DevLog tag protocol — index

Place tags at the **end** of your response. The Stop hook captures them; the dashboard renders them. Don't write tracking files or `queue.json` by hand — tags replace all of that.

Format: `-(tag) content` (case-sensitive), one tag per line. Write content in the user's language.

**Raw lines only.** Emit tags and commands as plain lines at line start. Anything wrapped in backticks or a code fence — like every example in these files — is treated as an EXAMPLE and ignored; the hook nudges you once if a whole line is a backticked command.

## Topics — read only the file you need

Paths are relative to this skill's directory.

| Need | File |
|---|---|
| Tag table (`desc`, `about`, `built`, `bug found`, `todo`, `decision`, `story`, `undo` …), length limits, atomic-content rules | `reference/tags.md` |
| Closing `#N` (`done`, `bug fix` + cause and failure class, `bug fix:interim`, `dropped`, reopen `⟲ #N`, same-response pairing, verify-before-closing), the `upcoming` tier | `reference/closure.md` |
| Which hooks block and when (closure-check, untagged guard, tracking-file gate, root-cause, load-bearing, release guards) and their mute switches | `reference/enforcement.md` |
| `-(release)`: bump detection, verification stamp, post-release mirror/build, manual version mode, the GitHub split | `reference/release.md` |
| `-(feature)`, `feature update/removed`, `ask:features`, `ask:backfill` | `reference/features.md` |
| `doc:report/analysis/plan/comparison/readme/update`, trackable plans and closing their steps | `reference/docs-plans.md` |
| Standards library: `ask:rules`, `rule:add`, `rule:new`, `rules:list`, `rule:rm`, `rule:ack(s)`, the two layers, what `[check]` really enforces | `reference/standards.md` |
| Dependencies: `ask:lib` (the version to install) and the install gate, `lib` / `ask:deps`, the `audit` vuln scan | `reference/deps.md` |
| Asking the record: `ask:search` (past decisions/fixes), `ask:recent` (last sessions), `ask:map` (where code lives), `ask:why` (one file's history) | `reference/recall.md` |
| Whole-history analysis: `ask:retro`, `ask:study`, `ask:record` | `reference/analysis.md` |

Open items and closures in one line: `-(ask:open)` pulls the live open list, `-(ask:closed) #N` says whether and how an item was closed — details in `reference/closure.md`.
