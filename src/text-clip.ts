// Surrogate-safe clipping (wave 10, F-3.7 / F-2.53). `s.slice(0, n)` counts
// UTF-16 units, so a cut that lands between the two halves of an astral
// character (emoji, mathematical alphanumerics, many CJK extension ideographs)
// leaves a lone high surrogate at the end: JSON.stringify escapes it (the
// store stays valid) but every renderer shows U+FFFD, and a slug built from it
// reaches the disk as a name the index file does not agree with. Every cap in
// DevLog that may cut inside user text goes through here.

/** `s` capped to at most `maxUnits` UTF-16 units, never ending in a lone high
 *  surrogate (the pair is dropped whole). */
export function clipUnits(s: string, maxUnits: number): string {
  if (maxUnits <= 0) return "";
  if (s.length <= maxUnits) return s;
  let end = maxUnits;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end);
}
