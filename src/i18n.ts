// DevLog UI language resolution.
//
// DevLog's enforcement messages (Stop-hook stderr shown to the user), the
// injected context, and the primer were Arabic-only, which reads as "broken" to
// a non-Arabic user watching their turn get rejected. Messages default to
// ENGLISH for a global audience; set DEVLOG_LANG=ar for Arabic. Locale-ish
// values are accepted (e.g. "ar", "ar-SA", "ar_EG" → Arabic).
//
// Message strings live next to the code that emits them (each module defines its
// own en/ar variants); this module only resolves which language to use, so there
// is no giant central catalog to keep in sync.
export type Lang = "en" | "ar";

export function currentLang(): Lang {
  const v = (process.env.DEVLOG_LANG || "").trim().toLowerCase();
  return v.startsWith("ar") ? "ar" : "en";
}
