// Shell writes as change rows (shell-write-events): a session that edited
// through sed/heredoc/`>` used to read "0 files" in ask:recent, the session
// summary, sessionTouchedFiles and the file story — only /api/changes/session
// derived shell writes. One read-time derivation now feeds them all.

import { describe, expect, test } from "bun:test";
import { SHELL_WRITE_TOOL, shellWriteEvents, withShellWrites } from "../src/shell-write-events";
import { buildRecent } from "../src/recent";
import { buildFileStory, sessionTouchedFiles } from "../src/file-story";
import type { DevLogData, EventEntry, TagEntry } from "../src/types";

const ROOT = "D:/proj";
const NOW = Date.now();
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

let seq = 0;
const cmd = (command: string, over: Partial<EventEntry> = {}): EventEntry => ({
  id: `c${++seq}`, project: "p", event: "PostToolUse", tool: "Bash", type: "command",
  command, session_id: "s1", timestamp: at(5), ...over,
});
const edit = (file: string, over: Partial<EventEntry> = {}): EventEntry => ({
  id: `e${++seq}`, project: "p", event: "PostToolUse", tool: "Edit", type: "change",
  file_path: `${ROOT}/${file}`, session_id: "s1", timestamp: at(5), lines_added: 2, lines_removed: 1, ...over,
});
const data = (events: EventEntry[], tags: TagEntry[] = []): DevLogData =>
  ({ projects: { p: { name: "p", path: ROOT } }, tags, events, plans: [], worklog: [], prompts: [], injections: [] }) as unknown as DevLogData;

describe("shellWriteEvents", () => {
  test("a heredoc rewrite yields one change-shaped row resolved against the project root", () => {
    const rows = shellWriteEvents(cmd("cat > src/a.ts <<'EOF'\nexport const a = 1;\nEOF"), ROOT);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r.type).toBe("change");
    expect(r.tool).toBe(SHELL_WRITE_TOOL);
    expect(r.file_path).toBe(`${ROOT}/src/a.ts`);
    expect(r.id).toBe(`${rows[0].id.split("#")[0]}#w1`);
    expect(r.session_id).toBe("s1");
    expect(r.lines_added).toBe(0);
    expect(r.old_string).toBeUndefined();
  });

  test("sed -i over two files → two rows; `./` prefix and duplicates collapse", () => {
    const rows = shellWriteEvents(cmd("sed -i 's/a/b/' ./src/a.ts src/b.ts && sed -i 's/c/d/' src/a.ts"), ROOT);
    expect(rows.map(r => r.file_path).sort()).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`]);
    expect(rows.map(r => r.id)).toEqual([`${rows[0].id.split("#")[0]}#w1`, `${rows[0].id.split("#")[0]}#w2`]);
  });

  test("an absolute target is kept; without a base a relative target stays relative", () => {
    expect(shellWriteEvents(cmd("echo x > D:/other/out.txt"), ROOT)[0].file_path).toBe("D:/other/out.txt");
    expect(shellWriteEvents(cmd("echo x > notes.md"))[0].file_path).toBe("notes.md");
  });

  test("a read-only command, a non-command event and an opaque write yield nothing", () => {
    expect(shellWriteEvents(cmd("grep -rn foo src && sed -n 1,20p src/a.ts"), ROOT)).toEqual([]);
    expect(shellWriteEvents(edit("src/a.ts"), ROOT)).toEqual([]);
    expect(shellWriteEvents(cmd("cat > $OUT <<EOF\nx\nEOF"), ROOT)).toEqual([]);
  });

  test("withShellWrites keeps every original row and inserts the derived rows after their command", () => {
    const c = cmd("echo hi >> README.md");
    const e = edit("src/a.ts");
    const out = withShellWrites([c, e], ROOT);
    expect(out.map(r => r.tool)).toEqual(["Bash", SHELL_WRITE_TOOL, "Edit"]);
    expect(out[1].file_path).toBe(`${ROOT}/README.md`);
  });
});

describe("consumers see shell writes", () => {
  test("ask:recent counts a heredoc-only session's files, keyed like an Edit path", () => {
    const d = data([
      cmd("cat > src/a.ts <<'EOF'\nx\nEOF"),
      edit("src/a.ts"),
      cmd("sed -i 's/x/y/' src/b.ts"),
    ]);
    const digest = buildRecent(d, "p", { sessions: 1 });
    const s = digest.sessions[0];
    const by = Object.fromEntries(s.files.map(f => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(by["src/a.ts"].edits).toBe(2);         // shell write + Edit, same key
    expect(s.commands.total).toBe(2);             // the derived rows are not commands
  });

  test("sessionTouchedFiles links a sed -i target; buildFileStory lists the shell write for that file", () => {
    const d = data([cmd("sed -i 's/a/b/' src/x.ts", { timestamp: at(1) })]);
    expect(sessionTouchedFiles(d, "s1", "p")).toEqual([`${ROOT}/src/x.ts`]);
    const story = buildFileStory(d, "p", `${ROOT}/src/x.ts`);
    expect(story.events).toHaveLength(1);
    expect(story.events[0].tool).toBe(SHELL_WRITE_TOOL);
  });
});
