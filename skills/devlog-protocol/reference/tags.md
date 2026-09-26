# DevLog — tags and atomic content

Format: `-(tag) content` (case-sensitive). Append `!` after the tag for a breaking change: `-(built!) X`. Multi-line content allowed (up to 2000 chars; 5000 for `about`); the first line is the headline. Write content in the user's language.

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
| `-(decision)` | Architectural decision + rationale — name the rejected alternative and why it lost; a wider trade-off study belongs in `-(doc:comparison)` |
| `-(insight)` | Root-cause finding from investigation |
| `-(story)` | The closing batch's narrative — TURNING POINTS only (a failed approach, a change of direction, a deliberate deferral), never a re-list of the tags. One per batch, ≤1200 chars. A soft nudge asks for it once after a batch that closes ≥2 items (a bare `-(release)` never asks — its work batches were nudged when they closed); it is stamped with an evidence verdict against the whole session trace and linked (`relatedNums`) to the items the batch closed. Surfaces: release page, `ask:why` dossier, `ask:recent`. |
| `-(undo) <text>` | Delete the most recent tag whose content includes `<text>` |
| `-(release) summary` | Release — DevLog auto-detects the bump type **and** computes the number. Force a type with `-(release:patch\|minor\|major)`, or a number with `-(release) vX.Y.Z` — never both: a type tag whose reason starts with a version is rejected wholesale. **Only when the user explicitly asks.** |
| `-(doc:TYPE) name\n<markdown>` | Generate `.md` + `.html` (see Doc tags) |

Token-saving: if SessionStart context already shows `desc:` or `about: yes`, don't re-emit them.

## Atomic content (strict)

One concept per tag. Headline-style tags (`todo`, `done`, `dropped`, `bug found`, `bug fix`, `security`, `security fix`, `note`) take a single ≤200-char line.

**Forbidden inside any tag content:** nested bullets (`\n- `), headings (`\n##`), questions (`?`), trailing planning prose. Multiple items → multiple tags. Need to ask the user → ask in the response, never inside a tag. Multi-line *body* is OK only for: `built`, `refactor`, `update`, `decision`, `insight`, `story`, `about`, `doc:*`.
