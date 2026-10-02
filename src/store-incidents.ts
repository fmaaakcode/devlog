// A corrupt store must never pass unnoticed — nor cost the user their history.
//
// data.ts quarantines an unparseable store (`<store>.json.corrupt-<stamp>`).
// Before this module it then booted that store EMPTY, said so only in
// server.log, and offered no way back: the user kept working on a blank log
// for days without knowing, and a hand copy of a `.bak` while the daemon ran
// was overwritten by the in-memory cache on its next save.
//
// Now: (1) restoreNewestBackup loads the newest `.bak` that parses and writes
// it back in place — a day-old history beats an empty one, and the corrupt
// original stays quarantined for manual recovery; (2) every quarantine is
// appended to `store-incidents.jsonl`, which SessionStart (every project) and
// doctor read, so Claude tells the user. An incident stays visible for
// INCIDENT_DAYS, or until the user deletes its `.corrupt-*` file (the ack).

import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteText } from "./atomic-write";

export const INCIDENTS_FILE = "store-incidents.jsonl";
const INCIDENT_DAYS = 7;

export interface StoreIncident {
  /** Store file name, e.g. `tags.json`. */
  store: string;
  /** Where the corrupt original was moved (absolute). */
  quarantinedTo: string;
  /** The `.bak` file name loaded in its place; absent = none parsed → empty store. */
  restoredFrom?: string;
  at: string;
}

/** Newest `<base>.*.bak` beside `path` that parses, written back over `path`.
 *  null when no backup parses — the caller falls back to the empty store. */
export async function restoreNewestBackup<T>(path: string): Promise<{ value: T; from: string } | null> {
  const base = basename(path).replace(/\.json$/, "");
  let baks: string[] = [];
  try {
    baks = readdirSync(dirname(path)).filter(f => f.startsWith(`${base}.`) && f.endsWith(".bak")).sort().reverse();
  } catch { return null; }
  for (const bak of baks) {
    try {
      const text = readFileSync(join(dirname(path), bak), "utf8");
      const value = JSON.parse(text) as T;
      await atomicWriteText(path, text);
      return { value, from: bak };
    } catch { /* this backup is unreadable or corrupt too — try the next older one */ }
  }
  return null;
}

export function recordIncident(dataDir: string, incident: StoreIncident): void {
  try { appendFileSync(join(dataDir, INCIDENTS_FILE), `${JSON.stringify(incident)}\n`); }
  catch { /* the log line in data.ts still carries it */ }
}

/** Unacknowledged incidents: recent, and their quarantined file still on disk. */
export function openIncidents(dataDir: string, now = Date.now()): StoreIncident[] {
  let text = "";
  try { text = readFileSync(join(dataDir, INCIDENTS_FILE), "utf8"); } catch { return []; }
  const out: StoreIncident[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const i = JSON.parse(line) as StoreIncident;
      if (now - Date.parse(i.at) > INCIDENT_DAYS * 86_400_000) continue;
      if (!existsSync(i.quarantinedTo)) continue;
      out.push(i);
    } catch { /* torn line */ }
  }
  return out;
}

type Lang = (en: string, ar: string) => string;

/** One line per incident, for the SessionStart context and doctor. */
export function incidentLine(i: StoreIncident, L: Lang): string {
  const day = i.at.slice(0, 16).replace("T", " ");
  return i.restoredFrom
    ? L(`${i.store} was corrupt (${day}) — restored from backup ${i.restoredFrom}; anything recorded after that backup is missing. Corrupt original kept at ${i.quarantinedTo} (delete it once checked).`,
        `${i.store} كان تالفًا (${day}) — استُرجع من النسخة الاحتياطية ${i.restoredFrom}؛ ما سُجّل بعدها مفقود. الأصل التالف محفوظ في ${i.quarantinedTo} (احذفه بعد التحقق).`)
    : L(`${i.store} was corrupt (${day}) and NO backup could be read — that store restarted EMPTY. Corrupt original kept at ${i.quarantinedTo} for manual recovery.`,
        `${i.store} كان تالفًا (${day}) ولا نسخة احتياطية سليمة — بدأ هذا المخزن فارغًا. الأصل التالف محفوظ في ${i.quarantinedTo} للاسترجاع اليدوي.`);
}
