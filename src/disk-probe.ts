// The one real "does this path exist?" probe (#858).
//
// It lives apart from path-utils.ts on purpose: that module declares zero
// dependencies beyond node:os/node:path so leaf modules can import it without
// pulling in anything heavier, and the deciding logic there (makeAbsenceJudge)
// takes the probe as an argument precisely so it stays pure and testable.
//
// Fails OPEN — anything other than "this path is not there" reads as "exists",
// because an fs hiccup must never invent a deletion inside a stored record. A
// false "deleted" in a published release page or a file dossier is worse than a
// missed one: it is the record lying with confidence.
//
// NOT existsSync: that swallows EVERY error into `false`, so a permission denial,
// a busy handle or a malformed path would all read as deleted — the exact false
// accusation this module exists to prevent (caught by its own test, which proved
// the try/catch around existsSync was decoration: existsSync never throws).
// statSync does throw, and only ENOENT means absent.

import { statSync } from "node:fs";
import type { ExistsProbe } from "./path-utils";

export const diskExists: ExistsProbe = (abs: string): boolean => {
  try {
    statSync(abs);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
};
