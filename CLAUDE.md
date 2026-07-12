# DevLog — project instructions

This is the DevLog repo itself. When working here, dogfood the tag protocol: emit
`-(tag) content` markers at the end of each response and the Stop hook captures them.
Write the tag content in the user's language.

> This file exists because the DevLog **plugin is disabled for this project**
> (`.claude/settings.json` → `enabledPlugins.devlog@devlog = false`) so you develop
> against the live working-tree code via the manual hooks. Outside this repo the
> plugin delivers the same protocol automatically (SessionStart primer + skill).

## Minimum tag vocabulary

- `-(desc)` the project's STABLE one-line identity — never a session summary (it feeds
  the dashboard header and the client report's subtitle; re-emit only when the project
  itself changes) · `-(about)` plain-language "what it is" + the concrete stack
  (language, runtime, frameworks, key libraries, integrations) — a technical ID card,
  not marketing prose
- `-(built)` new code not mapping to a plan step · `-(refactor)` restructure, no behavior change · `-(update)` dependency bump
- `-(bug found)` … / close with `-(bug fix) #N`
- `-(security[:own|:dep])` … / close with `-(security fix) #N`
- `-(todo)` … / close with `-(done) #N` or `-(dropped) #N`
- `-(upcoming)` deferred tier: create directly, or `-(upcoming) #N` to defer an open
  todo/bug (`-(todo) #N` promotes back). Never blocks a release; security never deferrable.
- `-(feature)` one client-language line per client-visible capability, declared when it
  lands (not per code step) · `-(feature update) #N new text` · `-(feature removed) #N` ·
  pull the current inventory with `-(ask:features)`. Not a work item — never blocks
  anything; a release with work tags but zero features gets a one-time soft reminder.
  Backfill old history: `-(ask:backfill)` lists releases no capability covers; after
  user approval declare each as `-(feature) [vX.Y.Z] <line>` — the marker pins the
  capability to the past release that shipped it.
- `-(note)` · `-(decision)` · `-(insight)`
- `-(doc:report|analysis|plan|comparison|readme)` name\n<markdown>

**Closure is mandatory** — every open item (todo/bug/security/plan step) is closed by
`#N` in the same response that finishes the work; never copy the text. `#N` numbers
arrive in the SessionStart context — or emit `-(ask:open)` to pull the live open list
yourself (bugs/todos/security/plan-steps) mid-session before closing, so you never
close a stale or wrong number. To check whether an item is *already* closed (and
when/how), emit `-(ask:closed) #N` instead of re-investigating finished work. For a
retrospective — every bug/security report ever, open and closed, with ages and files
("what keeps breaking?") — emit `-(ask:retro)` and codify recurring patterns with
`-(rule:add)` or `-(insight)`. For a full deep study (whole-history discipline
aggregates + narrative delta since the last study) emit `-(ask:study)` and store the
result as `-(doc:report) study-YYYY-MM-DD <title>` — the `study-` prefix makes it the
next study's watermark.

**Atomic** — one concept per tag; no questions or planning prose inside a tag.

**Releasing is yours; git is not.** Only when the user asks to ship: close every open
`#N`, then just emit `-(release) <reason>` — DevLog auto-detects the bump type and
computes the version + changelog. (Force a type with `-(release:patch|minor|major)`, a
number with `-(release) vX.Y.Z`.) Never run git/GitHub; the specialist pushes and tags
from the DevLog release. No `-(release)` unless asked.

## Full protocol reference

The complete rules (trackable plans `doc:plan`, doc generation, the standards library
`-(ask:rules)`, and the vuln audit `-(audit)`) live in
[`skills/devlog-protocol/SKILL.md`](./skills/devlog-protocol/SKILL.md). Read it when you
need the exact syntax for plans, docs, standards, or audits.
