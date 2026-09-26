# DevLog — recall and navigation: ask:search, ask:recent, ask:map, ask:why

## Recall (`ask:search`)

The log answers back: lexical search (BM25, Arabic+English normalization) over every stored tag — decisions, insights, notes, builds, closed bugs *with their fixes*. Prefer it over re-deriving a past decision or re-investigating a solved problem. Reply comes back in the same turn; NOT logged as a tag.

| Command | Use |
|---|---|
| `-(ask:search) why sse over websocket` | Best-matching stored tags of THIS project, each with `[tag] #N date — snippet` |
| `-(ask:search) all: oembed blocked` | Widen to every tracked project (cross-project recurrence) |

Matching is lexical, not semantic — use the vocabulary the log was written in (an English query won't match an Arabic-only tag). Auto-recall rides on it: when a fresh `-(bug found)` resembles a historically closed bug (enough shared terms), the next prompt's injection carries a one-shot `🧠` hint with the old fix's `#N`, close date and files — check it with `-(ask:closed) #N` before solving from scratch.

## The time door (`ask:recent`)

Every other pull asks by *subject* (a file, a question, an inventory); this one asks by *time*: "what happened last?". It serves the previous session(s)' digest — tags in order, files touched with edit sizes, commands run and which failed — with the **asking session always excluded** (its work is already in your context). Use it when picking up earlier work or returning after a gap, instead of reading raw store data. Reply comes back in the same turn; NOT logged as a tag.

| Command | Window |
|---|---|
| `-(ask:recent)` | The last session |
| `-(ask:recent) 3` | The last 3 sessions (max 10) |
| `-(ask:recent) 7d` | Sessions of the last 7 days (max 90d, 10 sessions) |

It is a digest, not a dump: per session at most 20 tags and 15 files are listed, with `+N` overflow counts, and a footer points to `-(ask:why)` / `-(ask:search)` for depth.

## Code map (`ask:map`)

Where the recall command answers *"what did we decide?"*, this answers *"where does this live, and what is each file for?"* — before you grep. Files are ranked by PageRank over the import graph (how much the rest of the code depends on them), and each line carries the purpose written at the top of that file, falling back to a heuristic only for files that document nothing. Same turn, never logged as a tag.

| Command | Use |
|---|---|
| `-(ask:map)` | Top files of the project, most-depended-on first, with purpose + size |
| `-(ask:map) release` | Only the files answering that subsystem — matched on path, purpose and exports |

Computed from a **live** analysis, not from `.devlog/DEVLOG_STACK.md` (which is generated once and can sit far behind the code). A query matching nothing returns the unfiltered top with a "nothing matched" note rather than an empty answer. Multi-word queries are AND — `-(ask:map) tag closure` means both.

The corollary is on you: a file with no purpose header gets a guessed description. Write the header when you create a module — three lines at the top (what it does, why it is separate, which trap it holds) is what makes this command worth asking.

## File archaeology (`ask:why`)

`ask:map` answers *"where do I look?"*. This answers *"what already happened HERE?"* — for one file. Pull it **before** rewriting something the rest of the code leans on, so you neither re-propose an approach that was rejected nor re-introduce a bug that was fixed. Same turn, never logged as a tag.

| Command | Use |
|---|---|
| `-(ask:why) src/data.ts` | That file's dossier |
| `-(ask:why) D:/proj/src/data.ts` | Absolute paths work too |

The answer carries, in order: the file's **purpose** (read live from its own header), the **decisions and insights** that shaped it, every **report** it caused — oldest first, each with how long it stayed open, `⟲` when the fix did not hold, and the reasoning stored on the fix — the newest **work** on it, and its **last change**. Every section is capped, and a cap always states how many it left out; a file with no history says so instead of failing.

The argument is required — a dossier needs a subject. Position memory (the automatic three-line whisper on a file's first read) points here whenever there is more to get, so the deep read stays opt-in.
