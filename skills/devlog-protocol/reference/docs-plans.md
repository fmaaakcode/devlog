# DevLog — doc tags and plans

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
