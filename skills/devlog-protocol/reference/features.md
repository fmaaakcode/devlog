# DevLog — features (the capability inventory)

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
release cut after it landed ("since vX.Y.Z" / unreleased) — unless its text opens
with an explicit `[vX.Y.Z]` marker, which pins it to that past release (the
backfill path for pre-feature-era history). It renders as the
"New capabilities" section of release pages and the backbone of the client
report (`/api/client-report` — the dashboard's "Client report" button; open
work appears there as a count only and
security as a reassurance line, never details).

**Soft release nudge**: a `-(release)` with work tags (`built`/`update`) accrued
since the last release but ZERO new `-(feature)` gets ONE reminder (the release
is held back once); declare the missed capability + re-emit the release, or
re-emit as-is for a purely technical release. Mute with `DEVLOG_FEATURE_NUDGE=0`.
