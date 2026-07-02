# DevLog — project instructions

This is the DevLog repo itself. When working here, dogfood the tag protocol: emit
`-(tag) content` markers at the end of each response and the Stop hook captures them.

> This file exists because the DevLog **plugin is disabled for this project**
> (`.claude/settings.json` → `enabledPlugins.devlog@devlog = false`) so you develop
> against the live working-tree code via the manual hooks. Outside this repo the
> plugin delivers the same protocol automatically (SessionStart primer + skill).

## Minimum tag vocabulary

- `-(desc)` one-line description · `-(about)` long description
- `-(built)` new code not mapping to a plan step · `-(refactor)` restructure, no behavior change · `-(update)` dependency bump
- `-(bug found)` … / close with `-(bug fix) #N`
- `-(security[:own|:dep])` … / close with `-(security fix) #N`
- `-(todo)` … / close with `-(done) #N` or `-(dropped) #N`
- `-(note)` · `-(decision)` · `-(insight)`
- `-(doc:report|analysis|plan|comparison|readme)` name\n<markdown>

**Closure is mandatory** — every open item (todo/bug/security/plan step) is closed by
`#N` in the same response that finishes the work; never copy the text. `#N` numbers
arrive in the SessionStart context.

**Atomic** — one concept per tag; no questions or planning prose inside a tag.

**Releases & git are not your job** — no `-(release)` and no git commands unless the
user explicitly asks.

## Full protocol reference

The complete rules (trackable plans `doc:plan`, doc generation, the standards library
`-(ask:rules)`, and the vuln audit `-(audit)`) live in
[`skills/devlog-protocol/SKILL.md`](./skills/devlog-protocol/SKILL.md). Read it when you
need the exact syntax for plans, docs, standards, or audits.
