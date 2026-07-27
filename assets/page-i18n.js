// Static-page i18n applier (#708): features.html has no page script of its
// own, so this tiny module applies the shared dictionary (data-i18n keys) on
// load. deps.js and stack-map.js call applyI18n themselves.
import { applyI18n } from "./dashboard-i18n.js";
applyI18n();
