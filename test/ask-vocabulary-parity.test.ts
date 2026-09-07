// Every served command must ALSO be a known command to the parser.
//
// The two lists have different jobs and no compiler link, which is how they
// drift: ASK_ROWS decides what the hook ANSWERS, COMMAND_TAGS decides what the
// parser RECOGNIZES. A command in the first but not the second looks fine in
// testing and then fails in three quiet ways:
//
//   • a body tag directly above it swallows the command line into its content
//     (the live artifact behind #580: a stored `built` ending in "-(ask:…)")
//   • the near-miss guard reads the unknown head as a typo and "corrects" a
//     command that is perfectly valid
//   • the backtick guard can't tell the user their command was inert
//
// This test is the link. It fired on the very command that motivated it:
// `-(ask:map)` was answerable before it was recognizable.

import { test, expect, describe } from "bun:test";
import { COMMAND_TAGS } from "../src/tag-parser";
import { ASK_ROWS } from "../src/hook-ask-rows";
import { RULE_COMMANDS } from "../src/standards";

describe("pull-command vocabulary parity", () => {
  test("every ASK_ROWS key is a known COMMAND_TAG", () => {
    const known = new Set<string>(COMMAND_TAGS);
    const missing = ASK_ROWS.map(r => r.key).filter(k => !known.has(k));
    expect(missing).toEqual([]);
  });

  // #1183 (F-9.109): the reverse direction. A COMMAND_TAG nobody serves is the
  // double silence #605 was built against, mirrored: the parser treats the line
  // as a command (no near-miss correction, no backtick nudge, never stored) and
  // no server answers it — inert AND quiet. Every recognized command must have
  // exactly one owner: the pull table (ASK_ROWS) or the standards rule commands
  // (RULE_COMMANDS, served by parse-tags Part 1.5).
  test("every COMMAND_TAG is served by ASK_ROWS or RULE_COMMANDS — no inert command", () => {
    const served = new Set<string>([...ASK_ROWS.map(r => r.key), ...RULE_COMMANDS]);
    const inert = COMMAND_TAGS.filter(c => !served.has(c));
    expect(inert).toEqual([]);
  });

  test("no command has two owners — a rule command must not also be a pull row", () => {
    const rows = new Set<string>(ASK_ROWS.map(r => r.key));
    expect(RULE_COMMANDS.filter(c => rows.has(c))).toEqual([]);
  });

  test("row keys are unique — two rows on one key would silently shadow", () => {
    const keys = ASK_ROWS.map(r => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every row can recognize its own bare command line", () => {
    for (const row of ASK_ROWS) {
      // `-(audit)` and the ask heads are matched with a fresh regex each time:
      // these are /g patterns, whose lastIndex would otherwise carry over.
      const re = new RegExp(row.re.source, row.re.flags);
      const line = `-(${row.key})`;
      const argLine = `-(${row.key}) something`;
      expect(re.test(line) || new RegExp(row.re.source, row.re.flags).test(argLine)).toBe(true);
    }
  });

  test("every row states where its answer comes from and how it is labelled", () => {
    for (const row of ASK_ROWS) {
      expect(row.path.startsWith("/api/")).toBe(true);
      expect(row.label.length).toBeGreaterThan(0);
      // A formatter, a full serve override, or `raw` (the endpoint already
      // returns display text). Neither of the three would block Claude with
      // "[object Object]".
      expect(Boolean(row.format || row.serve || row.raw)).toBe(true);
    }
  });
});
