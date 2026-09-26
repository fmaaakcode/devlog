# DevLog — analysis: ask:retro, ask:study, ask:record

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
`-(doc:report) study-YYYY-MM-DD <title>` — the `study-` (or `دراسة-`, Arabic mode) name
prefix is what makes the report the NEXT study's watermark. End it with a
"Summary" section (`الخلاصة` in Arabic): that section is the digest the next study builds on
(confirm each earlier pattern held, or declare it broken — never re-derive a
studied year). Stored studies appear in the dashboard's Docs section.

## Record audit (`ask:record`)

Every other pull READS the record and trusts it. This one CHECKS it, against today's capture rules — the parser's rules are the specification, so auditing is re-applying them to entries written under older, looser ones. No model, no language understanding: a blank line inside a `built`, a body that starts mid-sentence, a tag head eaten by the entry above it, a markdown table inside an oversized `done`.

| Command | Use |
|---|---|
| `-(ask:record)` | This project's audit |
| `-(ask:record) all:` | Every tracked project — a capture defect is rarely confined to one |

It also reports **shape drift**: the median length of each tag kind across time-ordered quarters, plus the newest slice on its own (a quarter split can hide a rise that is still happening). Drift is a habit, not a defect — it is context, never a finding.

Two limits are deliberate, not gaps. It reports **form, never truth**: whether an entry honestly describes what happened is a judgement, and a judgement needs a judge. And it **changes nothing** — repair is per-entry, explicitly confirmed, and archives the original first. There is no "repair all", because a sweep that rewrites history on the strength of a regex is exactly what this is built to argue against.

A finding means "does not match the rules as they are now", never "wrong": older entries were captured under the rules of their day, which were legitimate then.
