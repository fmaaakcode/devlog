# DevLog — closure and the upcoming tier

Every open tag has a closure, emitted in the **same response** as the work.

**Always close by `#N` — never copy the full text.** Re-emitting wording wastes tokens and risks a byte-level mismatch that leaves the item open forever. `#N` numbers arrive in the SessionStart context and the dashboard; type `?open` in a prompt for full text, or emit `-(ask:open)` yourself to pull the live open list (bugs/todos/security/plan-steps) mid-response before closing — so you never close a stale or wrong number. To verify an item is *already* closed (and see when/how it was closed), emit `-(ask:closed) #N` (or bare `-(ask:closed)` for the recent closures) instead of grepping `.devlog/` files or re-investigating finished work.

| Open | Close |
|---|---|
| `-(todo) X` | `-(done) #N` / `-(dropped) #N` |
| `-(bug found) X` — a defect that came back after its fix carries `⟲ #N` (or `reopen #N`) naming the CLOSED report: DevLog stores the link (`relatedTo`), echoes `[devlog reopen]`, and retro/model-stats charge the old fix as not held. A `#N` that is open, unknown, or not a problem report is ignored silently — no echo means the link did not take. Without a marker only a word-for-word re-report links; similar wording never does (the one-shot 🧠 recall hint suggests, it does not assert). | `-(bug fix) #N <cause>` — the root cause is gone. The cause text is stored on the closer (`cause`) and served by `-(ask:closed) #N`. Optional failure class right after the number, one word from the closed vocabulary in `src/failure-class.ts`: `-(bug fix) #N [شرط] <cause>` (`مطابق` text matcher · `شرط` condition scope · `حارس` missing guard · `بيئة` env/platform · `توقيت` timing/lifecycle · `صمت` silent failure · `بائت` stale output · `انحراف` duplicate drift · `عقد` contract bypass · `واجهة` doc/UI contradicts behavior · `نوع` type/conversion). Pick what would have PREVENTED the defect; an unknown word is dropped with a hint, absence = unclassified. The class is what makes a cross-cutting rule measurable: `ask:retro`/`ask:study` print each adopted rule’s before/after report rate on ITS classes (verification → matcher/condition/missing-guard/silent; data-integrity → stale/drift/contract; design → interface) and say “insufficient — classified X%/Y%” until history is classified. Backfill old closers only with the user’s approval, in small batches: `bun scripts/backfill-failure-class.ts list` serves the material, `apply <file> --confirm` writes (archived first, stamped as backfilled, never over a class the closer wrote). Two honest alternatives: `-(bug fix:interim) #N` when you knowingly shipped a STOPGAP (tracked as visible debt in `ask:retro`, and its later return reads as expected), or `-(dropped) #N` to WITHDRAW a report that turned out not to be a defect (collapsed premise, duplicate, deliberate behavior). Never record a fix that did not happen. |
| `-(security[:own/:dep]) X` | `-(security fix) #N` — security is never droppable |
| `[ ] step` in `doc:plan` | `-(done) #N` |
| all `[ ]` under `### Pn` | `-(done) Pn` |

**Opened AND finished in the SAME response** (a `-(bug found)` plus its fix, a `-(todo)` done immediately): emit the closer with **no number at all** — DevLog pairs it with the single work item opened in that response and echoes `🔗` with the real `#N`. Never guess the next `#N`: numbers are assigned only after the response ends, and a guessed number is rejected (or, when it matches nothing and exactly one item was opened this response, auto-paired with a corrective echo). **Text closure is permitted ONLY** when injection is off. Otherwise use `#N`.

**Verify before closing.** "Verified" = observed evidence in this conversation (a passing test in the transcript, a successful tool result, explicit user confirmation). Reading code and concluding "it should work" is **not** verification. If you can't verify this turn, leave it open and emit a `-(note)` stating what's needed. The Stop hook cross-checks closures against the session trace: a test run that **failed**, or one that **predates your last code edit**, does not count as evidence — run the suite again, after the change, and see it pass.

`-(built)` is not a closure — if work maps to a plan step, also emit `-(done) #N`. Don't fake-close security tags: if you reviewed but didn't fix, say so; don't emit `-(security fix)`.

## Upcoming — the deferred tier

Two tiers of open work: **committed** (todo/bug/plan-step — the guard enforces closure and blocks releases) and **upcoming** (recorded ambition — visible everywhere, enforced nowhere). Use upcoming for ideas worth keeping that nobody is committing to now, instead of parking them outside DevLog.

| Command | Effect |
|---|---|
| `-(upcoming) X` | Create a deferred item directly (numbered like a todo) |
| `-(upcoming) #N` | Defer the open todo/bug `#N` in place — same number, history intact |
| `-(todo) #N` | Promote upcoming `#N` back to a committed todo |
| `-(done) #N` / `-(bug fix) #N` | Close an upcoming item directly — no promotion needed |

Rules: a `#N` that is an open **plan step** defers/promotes that step only — its siblings stay committed (the dashboard ☾ button is what defers a whole plan). **Security items are never deferrable** — fix them or leave them open. Upcoming items don't block `-(release)`, don't trigger the closure-check, and don't count in "Open now"; they appear as one awareness line at SessionStart (toggle: Injection panel → "Upcoming line"), in the "Upcoming" tabs on the dashboard's tasks/plans cards, in `?open` / `-(ask:open)` under their own section, and each release page snapshots them in an "Upcoming" section.
