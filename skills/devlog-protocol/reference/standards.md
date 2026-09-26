# DevLog — the standards library

A reusable rules library lives at `~/.claude/standards/`, organized by axis (`languages/`, `platforms/`, `app-types/`, `cross-cutting/`). **Standards are silent by default: pull a category only when the user asks for it** (e.g. "apply the design standards") — never on your own initiative, because a category that does not fit the open project steers the work the wrong way. Replies come back **in the same turn** (served via the Stop hook's stderr). These commands are NOT logged as tags.

| Command | Use |
|---|---|
| `-(ask:rules) <cat> [<cat>…]` | Pull one or more categories' rules |
| `-(rule:add) <cat>`<br>`<rule text>` | Append a permanent rule (append-only, dedup'd). Inside a project it lands in the project layer (`<root>/.devlog/standards/`), starting the file if the category exists only globally |
| `-(rule:add) global:<cat>`<br>`<rule text>` | Promote: append to the global library instead — only for a rule that would still make sense in an unrelated project |
| `-(rule:new) <axis>/<cat>` | Create a new category (project layer inside a project, global outside); `global:` / `project:` prefix overrides |
| `-(rules:list)` | Show the full catalog |
| `-(rule:rm) [global:]<cat> #N` | Remove rule #N — from the project file if one exists, else the global one; `global:` targets the library explicitly |
| `-(rule:ack) <key>` | Confirm a blocked standards/dep violation as intentional for THIS project (e.g. `cargo-edition`, `cargo-edition:2021`, `dep:astro` — the exact key comes in the block message); the same write passes when re-issued |
| `-(rule:acks)` | List this project's confirmed acks |

Available category names are injected at SessionStart under "Available standards" ("معايير متاحة" in Arabic mode). For a rich reference standard (design tokens, tables), write the file directly at `~/.claude/standards/<axis>/<category>.md`.

**Two layers, project first.** Rules you write from inside a project land in that project's layer by default, so a rule about this project's host, client, product, or a one-off convention never reaches other projects. Promote a rule with `global:` only when it would still make sense in an unrelated project (a language idiom, a universal engineering practice). `-(ask:rules)` shows both layers, marking the project one "project-local"; the SessionStart list stars project-local names (`vercel*`). The library root follows `CLAUDE_CONFIG_DIR` when set (`<config>/standards`), or `DEVLOG_STANDARDS_DIR` to point it anywhere.

**Category file shape.** Each category is one `.md` file: a `## When it applies` section (one sentence — the only hint for when to pull it; `-(rules:list)` flags categories where it is missing or still the template text) and a `## Rules` section of `- ` bullets, numbered `#1, #2…` on read.

**`[check]` vs `[guide]` — what really blocks.** A rule may start with `[check]`/`[فحص]` (verifiable) or `[guide]`/`[نصيحة]` (advisory); unmarked = guide. The marker alone enforces nothing: a write is blocked only by a checker built into DevLog (`src/write-checks.ts`, `WRITE_CHECKERS`). Today exactly one is active — the Rust `edition` check on `Cargo.toml`; the C++ standard and raw-hex design checkers exist but are disabled. Treat every other rule, marked `[check]` or not, as guidance you apply yourself.

`{{latest:<lang>}}` / `{{edition:<lang>}}` placeholders in a rule are resolved to live toolchain values when the category is served.
