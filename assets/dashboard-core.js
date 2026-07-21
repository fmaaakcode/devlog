        // R3 #3: ES module. Shared mutable state lives in dashboard-state.js;
        // cross-file functions are explicit imports — a renamed or missing one
        // now fails at load with a visible import error instead of a swallowed
        // TypeError at click time.
        import { data, activeProject, showCompletedPlans, setShowCompletedPlans, setTodosTab, setPlansTab } from "./dashboard-state.js";
        import { rescanProject, vulnScan, expandHistory, refreshActiveView } from "./dashboard-data.js";
        import { selectProject, deleteProject, renameProject, cleanupTombstones, importProjectBundle, vulnCache } from "./dashboard-project.js";
        import { openSessionsPanel, killPid, killServer, refreshProcesses, renderActivePlanCard, renderTodosCard, hidePlan, togglePlanUpcoming, renderProject, planExpanded } from "./dashboard-panels.js";
        import { setLogFilter, clearInjectionOverride, toggleInjection, showInjectionContent, switchInjScope, openInjectionPanel, openStandardsPanel, closeInjectionPanel, closeStandardsPanel, openUpdatesPopup, openTargetFile, ignoreTarget } from "./dashboard-tree-ws.js";

        // Derive from where the dashboard is served, so it follows DEVLOG_PORT
        // instead of hardcoding 7777 (R3 P5).
        export const API = location.origin;

        // Foreground colors for tool badges — single source (was duplicated in
        // updateCards + renderFiles with a drifted Agent shade) (R3 P7). The
        // dark background tints near the file tree are a separate concept.
        export const TOOL_FG_COLORS = { Create: 'var(--emerald)', Edit: 'var(--gold)', Read: 'var(--blue)', Bash: 'var(--pink)', PowerShell: 'var(--pink)', Agent: '#bb86fc', Plan: 'var(--gold)' };

        // Allow only http(s) links; blocks javascript:/data: URIs coming from an
        // untrusted git remote (.git/config) or vuln API (security audit D3).
        export function safeHref(url) {
            const u = String(url || "").trim();
            return /^https?:\/\//i.test(u) ? u : "#";
        }

        // Destructive endpoints may demand X-DevLog-Token (DEVLOG_REQUIRE_TOKEN=1).
        // Every mutating button goes through this — the server was enforcing the
        // gate while the dashboard's own buttons never attached the header, so
        // enabling the feature silently broke them (401). One cached /api/token
        // fetch serves the session; with the feature off it adds nothing.
        let tokenHeaderCache = null;
        export async function destructiveHeaders(extra) {
            if (tokenHeaderCache === null) {
                try {
                    const t = await (await fetch(`${API}/api/token`)).json();
                    tokenHeaderCache = (t.required && t.token) ? { 'X-DevLog-Token': t.token } : {};
                } catch { tokenHeaderCache = {}; }
            }
            return { ...(extra || {}), ...tokenHeaderCache };
        }
        // R3 #7: native alert/confirm/prompt block the event loop — WebSocket
        // updates freeze behind them — and can't be styled. Same .inj-modal
        // shell as the other dialogs, resolving a Promise instead of blocking.
        // Message and title go in via textContent, never innerHTML, so callers
        // can pass server-derived text without an XSS path.
        // Teardown hook for the dialog currently on screen. Replacing a pending
        // dialog used to `old.remove()` the DOM only — its Promise never
        // settled (the awaiting flow hung forever) and its document keydown
        // listener leaked, so a later Enter could fire BOTH dialogs' actions
        // (R3 review #1). Now a replacement runs the same teardown as a normal
        // cancel: resolve, unlisten, remove.
        let closeActiveDialog = null;
        function uiDialog(message, { title = "تنبيه", okText = "حسنًا", cancelText = null, danger = false, input = null } = {}) {
            return new Promise((resolve) => {
                if (closeActiveDialog) closeActiveDialog();
                const wrap = document.createElement("div");
                wrap.id = "confirmModal";
                wrap.className = "inj-modal-bg open";
                const box = document.createElement("div");
                box.className = "inj-modal confirm-modal";
                box.dataset.action = "noop";
                box.innerHTML = '<div class="inj-header"><span class="inj-title"></span><button class="inj-close" title="إغلاق">✕</button></div><div class="confirm-msg"></div><div class="confirm-actions"></div>';
                box.querySelector(".inj-title").textContent = title;
                box.querySelector(".confirm-msg").textContent = message;
                let inputEl = null;
                if (input !== null) {
                    inputEl = document.createElement("input");
                    inputEl.className = "confirm-input";
                    inputEl.value = input;
                    box.querySelector(".confirm-msg").after(inputEl);
                }
                // cancel value: false for confirm, null for prompt, true for plain alert
                const cancelValue = input !== null ? null : !cancelText;
                const okValue = () => inputEl ? inputEl.value.trim() : true;
                const done = (v) => { closeActiveDialog = null; document.removeEventListener("keydown", onKey); wrap.remove(); resolve(v); };
                const onKey = (e) => {
                    if (e.key === "Escape") done(cancelValue);
                    else if (e.key === "Enter") done(okValue());
                };
                const actions = box.querySelector(".confirm-actions");
                const mk = (label, val, cls) => {
                    const b = document.createElement("button");
                    b.className = cls;
                    b.textContent = label;
                    b.onclick = () => done(typeof val === "function" ? val() : val);
                    actions.appendChild(b);
                    return b;
                };
                if (cancelText) mk(cancelText, cancelValue, "confirm-btn");
                const okBtn = mk(okText, okValue, `confirm-btn ${danger ? "danger" : "primary"}`);
                box.querySelector(".inj-close").onclick = () => done(cancelValue);
                wrap.addEventListener("click", (e) => { if (e.target === wrap) done(cancelValue); });
                document.addEventListener("keydown", onKey);
                closeActiveDialog = () => done(cancelValue);
                wrap.appendChild(box);
                document.body.appendChild(wrap);
                (inputEl || okBtn).focus();
                if (inputEl) inputEl.select();
            });
        }
        export const uiAlert = (message, title = "تنبيه") => uiDialog(message, { title });
        export const uiConfirm = (message, opts = {}) => uiDialog(message, { title: opts.title || "تأكيد", okText: opts.okText || "نعم، نفّذ", cancelText: opts.cancelText || "إلغاء", danger: opts.danger !== false });
        // prompt() replacement: resolves the trimmed string, or null on cancel.
        export const uiPrompt = (message, initial, opts = {}) => uiDialog(message, { title: opts.title || "إدخال", okText: opts.okText || "موافق", cancelText: "إلغاء", danger: false, input: initial ?? "" });

        // Delegated listener for [data-action] elements. Replaces the old
        // onclick="fn('${esc(x)}')" pattern, which was XSS-prone because
        // HTML entity decoding inside JS-in-attribute context lets `&#39;`
        // close the string and inject code. Reading via dataset hands the
        // raw value to the handler — never evaluated as JS.
        document.addEventListener("click", (e) => {
            const el = e.target.closest("[data-action]");
            if (!el) return;
            const action = el.dataset.action;
            const project = el.dataset.project;
            if (action === "select-project") selectProject(project);
            else if (action === "delete-project") { e.stopPropagation(); deleteProject(project); }
            else if (action === "rename-project") { e.stopPropagation(); renameProject(project); }
            else if (action === "open-sessions") openSessionsPanel(project);
            else if (action === "cleanup-tombstones") cleanupTombstones();
            // Portable project bundle: ⤓ downloads (Content-Disposition does the
            // rest), ⤒ picks a bundle file and merge-imports it.
            else if (action === "export-project") { e.stopPropagation(); window.location.assign(`${API}/api/project-export/${encodeURIComponent(project)}`); }
            else if (action === "import-project") importProjectBundle();
            else if (action === "kill-pid") killPid(parseInt(el.dataset.pid, 10), project);
            else if (action === "refresh-processes") refreshProcesses(project);
            else if (action === "toggle-plan") {
                const id = el.dataset.planId;
                planExpanded[id] = !planExpanded[id];
                renderActivePlanCard(activeProject);
            }
            else if (action === "hide-plan") {
                e.stopPropagation();
                hidePlan(el.dataset.planId, el.dataset.planTitle);
            }
            else if (action === "toggle-completed-plans") {
                setShowCompletedPlans(!showCompletedPlans);
                renderActivePlanCard(activeProject);
            }
            // الحالية/القادمة tabs (tasks + plans cards) + plan defer/promote.
            // Each tab switch redraws ITS card only, without the live-update
            // flash — cards are independent; switching one must not reload the rest.
            else if (action === "set-todos-tab") { setTodosTab(el.dataset.key); renderTodosCard(false); }
            else if (action === "set-plans-tab") { setPlansTab(el.dataset.key); renderActivePlanCard(activeProject, false); }
            else if (action === "toggle-plan-upcoming") {
                e.stopPropagation();
                togglePlanUpcoming(el.dataset.planId, el.dataset.upcoming === 'true');
            }
            else if (action === "delete-tag") {
                e.stopPropagation();
                deleteTag(el.dataset.tagId, el.dataset.tagKind);
            }
            // Converted from inline onclick (R3 P7) — keeps CSP free of the
            // remaining unsafe-inline handlers.
            else if (action === "set-log-filter") setLogFilter(el.dataset.key);
            // History window (R8 perf): refetch this project's view unwindowed.
            else if (action === "expand-history") { expandHistory(activeProject); refreshActiveView(true); }
            else if (action === "close-sessions-modal") { const m = document.getElementById('sessionsModal'); if (m) m.remove(); }
            else if (action === "clear-injection-override") clearInjectionOverride();
            else if (action === "toggle-injection") toggleInjection(el.dataset.key, el.dataset.value === 'true');
            else if (action === "show-injection-content") showInjectionContent(el.dataset.id);
            else if (action === "switch-inj-scope") switchInjScope(el.dataset.scope);
            else if (action === "show-vulns") showVulnsModal(el.dataset.project, el.dataset.lib);
            else if (action === "show-vulns-tag") showVulnsFromTag(el.dataset.project, el.dataset.content);
            else if (action === "close-vulns-modal") { const m = document.getElementById('vulnsModal'); if (m) m.remove(); }
            else if (action === "noop") { /* swallow clicks inside a modal so the backdrop doesn't close it */ }
            // Converted from the last inline onclick handlers in dashboard.html
            // (report #5) so CSP can drop script-src 'unsafe-inline'. `el` replaces
            // the old `this`; activeProject is the shared global.
            else if (action === "rescan-project") rescanProject(activeProject, el);
            else if (action === "vuln-scan") vulnScan(activeProject, el);
            else if (action === "open-injection-panel") openInjectionPanel(activeProject);
            else if (action === "open-standards-panel") openStandardsPanel(activeProject);
            else if (action === "kill-server") killServer(el);
            else if (action === "open-updates-popup") openUpdatesPopup();
            // #448: the version chip's click-through to the full releases page
            // (the hover popover shows the latest summary inline).
            else if (action === "open-releases") window.open(`${API}/releases/${encodeURIComponent(activeProject)}`, "_blank", "noopener");
            // #490: live preview of the NEXT release — served under the same
            // base as the baked pages so its relative links resolve.
            else if (action === "open-release-preview") window.open(`${API}/releases/${encodeURIComponent(activeProject)}/preview.html`, "_blank", "noopener");
            // Client-facing status report — rendered live server-side; the
            // browser tab is the review/print/save surface.
            else if (action === "open-client-report") window.open(`${API}/api/client-report?project=${encodeURIComponent(activeProject)}`, "_blank", "noopener");
            else if (action === "open-target-file") openTargetFile();
            else if (action === "ignore-target") ignoreTarget();
            else if (action === "close-injection-panel") closeInjectionPanel();
            else if (action === "close-standards-panel") closeStandardsPanel();
        });

        async function deleteTag(tagId, kind) {
            const label = kind === "security" ? "ثغرة" : kind === "bug" ? "خلل" : "تاق";
            if (!(await uiConfirm(`حذف هذه الـ${label} نهائياً؟\nاستخدم هذا فقط للـfalse positive أو الإدخال الخاطئ. للإصلاح الفعلي استخدم -(security fix) #N أو -(bug fix) #N.`, { okText: "احذف نهائيًا" }))) return;
            try {
                const res = await fetch(`${API}/api/tag/${encodeURIComponent(tagId)}`, { method: "DELETE", headers: await destructiveHeaders() });
                if (res.ok) {
                    data.tags = (data.tags || []).filter(t => t.id !== tagId);
                    renderProject();
                } else {
                    uiAlert("فشل الحذف");
                }
            } catch (e) {
                uiAlert(`خطأ: ${e.message}`);
            }
        }

        // Strip the "@version" suffix off a security-tag headline ("name@version —
        // …") to recover the library key. Handles scoped npm names (@scope/pkg)
        // by removing only the LAST "@…" segment.
        function libFromSecurityTag(content) {
            const before = String(content || "").split(" — ")[0];
            return before.replace(/@[^@]*$/, "").trim();
        }
        // Opening the modal from a security tag in the activity log (vs the deps
        // badge) — same modal, with the tag text as a fallback when no scan detail.
        function showVulnsFromTag(project, content) {
            showVulnsModal(project, libFromSecurityTag(content), content);
        }

        // Vuln-details modal: lists every advisory OSV reported for one library
        // (the badge/tag shows only the count + top severity). All fields are
        // rendered through esc()/safeHref() — OSV data is external/untrusted
        // (matches the server-side sanitization at store time). fallbackText (the
        // tag headline) is shown when there's no scanned detail for the library.
        function showVulnsModal(project, lib, fallbackText) {
            const vulns = (vulnCache?.[project]) || (data.projects[project]?.vulnResults) || {};
            const v = vulns[lib];
            const sevColors = { critical: '#ff1744', high: '#ff5252', moderate: '#ff9800', low: '#ffd93d', none: 'var(--text2)' };
            let titleCount = '';
            let fixLine = '';
            let rows;
            if (v && (v.vulns > 0 || v.notices > 0)) {
                titleCount = v.vulns > 0 ? ` — ${v.vulns}` : '';
                const list = Array.isArray(v.advisories) ? v.advisories : [];
                fixLine = v.fixVersion
                    ? `<div class="vuln-fix">رقِّ لـ <b>${esc(v.fixVersion)}</b> ${list.some(a => !a.fix) ? '(يبقى بعضها بلا إصلاح)' : 'لإغلاقها كلها'}</div>`
                    : '';
                // Older cached results have no advisories[] — fall back to the headline.
                rows = list.length
                    ? list.map(a => {
                        const sev = (a.severity || 'none').toLowerCase();
                        const col = sevColors[sev] || 'var(--text2)';
                        const href = safeHref(a.url);
                        const idHtml = href !== '#'
                            ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">${esc(a.id || 'advisory')} ↗</a>`
                            : esc(a.id || 'advisory');
                        // Informational RustSec notices (unmaintained/unsound) are
                        // warnings, not CVEs — a gold label instead of the red
                        // "لا إصلاح" chip that made archived crates read as danger.
                        const kind = (a.kind && a.kind !== 'vuln') ? String(a.kind) : '';
                        const kindLabel = kind === 'unmaintained' ? 'غير مُصان'
                            : kind === 'unsound' ? 'غير سليم (unsound)'
                            : kind ? 'إشعار' : '';
                        const fix = kindLabel
                            ? `<span class="vuln-row-fix" style="color:var(--gold)">${esc(kindLabel)}</span>`
                            : (a.fix
                                ? `<span class="vuln-row-fix">fix ${esc(a.fix)}</span>`
                                : `<span class="vuln-row-nofix">لا إصلاح</span>`);
                        return `<div class="vuln-item"><span class="vuln-dot" style="background:${col}"></span><div class="vuln-item-main"><div class="vuln-item-top"><span class="vuln-sev" style="color:${col}">${esc(sev)}</span> ${idHtml}</div><div class="vuln-item-sum">${esc(a.summary || '')}</div></div>${fix}</div>`;
                    }).join("")
                    : `<div class="vuln-item"><div class="vuln-item-main">${esc(v.message || 'تفاصيل غير متوفّرة')}${safeHref(v.detailsUrl) !== '#' ? ` <a href="${esc(safeHref(v.detailsUrl))}" target="_blank" rel="noopener" style="color:var(--blue)">↗</a>` : ''}</div></div>`;
            } else if (fallbackText) {
                // No scanned detail (data cleared, or a pre-advisories scan) — show
                // the tag headline + a hint to re-scan for the full per-CVE list.
                rows = `<div class="vuln-item"><div class="vuln-item-main">${esc(fallbackText)}<div class="vuln-item-sum" style="margin-top:6px;color:var(--gold)">اضغط «افحص الآن» لتفاصيل كل ثغرة.</div></div></div>`;
            } else {
                return;
            }
            const old = document.getElementById('vulnsModal');
            if (old) old.remove();
            const wrap = document.createElement('div');
            wrap.id = 'vulnsModal';
            wrap.className = 'inj-modal-bg open';
            wrap.dataset.action = 'close-vulns-modal';
            wrap.innerHTML = `<div class="inj-modal" data-action="noop" style="width:min(680px,92vw)"><div class="inj-header"><span class="inj-title">ثغرات ${esc(lib)}${titleCount}</span><button class="inj-close" data-action="close-vulns-modal" title="إغلاق">✕</button></div><div class="vuln-modal-body">${fixLine}${rows}</div></div>`;
            document.body.appendChild(wrap);
        }

        // Memory/doc hover popover. Looks up the live entry from
        // data.projects[active] each time (no stale cache after re-render).
        // The popover itself is hoverable so the user can scroll its body —
        // we only hide when the cursor leaves both the row AND the popover.
        (function setupMemPopover() {
            const pop = () => document.getElementById("memPopover");
            let hideTimer = null;
            const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
            const scheduleHide = () => {
                cancelHide();
                hideTimer = setTimeout(() => { const el = pop(); if (el) el.style.display = "none"; }, 120);
            };

            function lookup(kind, idx) {
                const proj = data.projects[activeProject];
                if (!proj) return null;
                const list = kind === "docs" ? proj.docFiles : proj.memoryFiles;
                return (list || [])[idx] || null;
            }

            function show(anchor, payload) {
                const el = pop();
                if (!el) return;
                el.innerHTML =
                    `<div class="pop-name">${esc(payload.name)}</div>` +
                    (payload.description ? `<div class="pop-desc">${esc(payload.description)}</div>` : "") +
                    `<div class="pop-body">${esc(payload.body || "(فارغ)")}</div>`;
                el.style.display = "block";
                el.scrollTop = 0;
                positionPopover(anchor);
                cancelHide();
            }

            function showFromRow(row) {
                const item = lookup(row.dataset.memKind, parseInt(row.dataset.memIdx, 10));
                if (!item) return;
                show(row, {
                    name: item.name || item.file,
                    description: item.description,
                    body: item.body || "(فارغ — قد تحتاج إعادة مسح)",
                });
            }

            function showFromAbout(btn) {
                const proj = data.projects[activeProject];
                if (!proj) return;
                const has = proj.about?.trim();
                show(btn, {
                    name: proj.name,
                    description: proj.description || "",
                    body: has ? proj.about : "لا يوجد محتوى about لهذا المشروع. أرسل `-(about) ...` لإضافته.",
                });
            }

            // #448: hovering the header version shows the latest release's
            // summary right here (the release tag already carries it) instead
            // of the user digging release .html files out of the folder;
            // clicking opens the full releases page (open-releases action).
            function showFromRelease(el) {
                const rel = (data.tags || [])
                    .filter(t => t.project === activeProject && t.tag === "release")
                    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
                if (!rel) return;
                const when = new Date(rel.timestamp).toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" });
                show(el, {
                    name: rel.content.match(/v[\d.]+/)?.[0] || "آخر إصدار",
                    description: `صدر ${when} — اضغط لفتح صفحة الريليزات`,
                    body: rel.content,
                });
            }

            const isHoverable = (target) =>
                target?.closest && (target.closest(".mem-row") || target.closest("[data-about-btn]") || target.closest("[data-release-pop]") || target.closest("#memPopover"));

            document.addEventListener("mouseover", (e) => {
                const row = e.target.closest(".mem-row");
                if (row) { showFromRow(row); return; }
                const aboutBtn = e.target.closest("[data-about-btn]");
                if (aboutBtn) { showFromAbout(aboutBtn); return; }
                const relEl = e.target.closest("[data-release-pop]");
                if (relEl) { showFromRelease(relEl); return; }
                if (e.target.closest("#memPopover")) cancelHide();
            });
            document.addEventListener("mouseout", (e) => {
                if (!isHoverable(e.target)) return;
                if (isHoverable(e.relatedTarget)) return;
                scheduleHide();
            });

            function positionPopover(row) {
                const el = pop();
                if (!el) return;
                const r = row.getBoundingClientRect();
                const pw = el.offsetWidth;
                const ph = el.offsetHeight;
                let left = r.left - pw - 8;
                if (left < 8) left = r.right + 8;
                if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
                let top = r.top;
                if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
                el.style.left = `${Math.max(8, left)}px`;
                el.style.top = `${top}px`;
            }
        })();

        export const langColors = {
            TypeScript: "#3178c6", JavaScript: "#f7df1e", Python: "#3776ab",
            Rust: "#dea584", Go: "#00add8", Java: "#ed8b00", "C#": "#68217a",
            PHP: "#777bb4", Ruby: "#cc342d", Swift: "#fa7343", Dart: "#0175c2",
            Vue: "#42b883", Svelte: "#ff3e00", default: "#118ab2"
        };

        export const tagLabels = {
            plan: "خطة", built: "بناء", todo: "مهمة", done: "منجز", dropped: "ملغي",
            "bug found": "خلل", "bug fix": "إصلاح", security: "أمني", "security fix": "إصلاح أمني",
            release: "إصدار", note: "ملاحظة", update: "تحديث", refactor: "إعادة هيكلة", outdated: "قديم",
            decision: "قرار", insight: "تحقيق",
            "security:dep": "أمني (تبعية)", "security:own": "أمني (كود)"
        };

        // Filter groups for log tab
        export const filterGroups = {
            all: null,
            build: ["built", "refactor", "update"],
            bugs: ["bug found", "bug fix"],
            security: ["security", "security fix", "security:dep", "security:own", "outdated"],
            tasks: ["plan", "todo", "done", "dropped"],
            knowledge: ["decision", "insight", "note"],
            other: ["release"]
        };
        export const filterLabels = {
            all: "الكل", build: "البناء", bugs: "الأخطاء",
            security: "الأمان", tasks: "المهام", knowledge: "معرفة", other: "أخرى"
        };

        // Mirror of SECURITY_OPEN_TAGS in src/data.ts — the opener tags that count
        // as a security item. The dashboard used to filter `t.tag === "security"`
        // alone, silently dropping `security:own`/`security:dep` from every count
        // and list (e.g. project-x #103 showed open in ?open but vanished here).
        export const SEC_OPEN_TAGS = new Set(["security", "security:own", "security:dep"]);

        export function esc(s) {
            if (!s) return "";
            return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
        }
        // Compact display: tags may now hold body up to 2000 chars; the dashboard
        // shows only the first line + ~120 chars to keep rows scannable.
        export function tagSummary(s, max = 120) {
            if (!s) return "";
            const firstLine = s.split("\n")[0];
            return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
        }
        // The client-side closure/fuzzy mirrors (sharedPrefixClose, isDoneFuzzy,
        // normTag, fuzzy, closedNumSet) were removed in #379 — open/closed
        // judgments now come from GET /api/verdicts/:project, the same
        // resolvers behind ask:open and the release guard, so the dashboard
        // can no longer drift from the server on the same data.
        export function timeStr(ts) {
            return new Date(ts).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
        }
        // Opened-at line for hover tooltips (security card's open lists; mirrors
        // the tasks card's addedTitle and ?open/ask:closed's «فُتح» line).
        export const openedTitle = (ts) => ts ? `فُتحت: ${String(ts).slice(0, 16).replace('T', ' ')}` : '';
        export function tagClass(tag) { return tag.replace(/[\s:]+/g, ""); }
        // For closure tags whose content is `#N` or `Pn(.m)`, show a richer
        // label by looking up the original item. Falls back to raw content.
        export function resolveTagDisplay(t, allTags, plans) {
            const c = (t.content || "").trim();
            const numM = c.match(/^#?\s*(\d+)\s*$/);
            if (numM) {
                const num = parseInt(numM[1], 10);
                const tFound = allTags.find(x => x.project === t.project && x.num === num && x.id !== t.id);
                if (tFound) return `#${num} — ${tFound.content}`;
                for (const p of plans) {
                    const s = (p.steps || []).find(s => s.num === num);
                    if (s) return `#${num} — ${s.text}`;
                }
            }
            const phaseM = c.match(/^(P\d+(?:\.\d+)?)$/);
            if (phaseM) {
                const code = phaseM[1];
                for (const p of plans) {
                    const matched = (p.steps || []).filter(s => s.phase === code);
                    if (matched.length) return `${code} — ${matched.length} خطوة في "${p.title}"`;
                }
            }
            return c;
        }
        // ===== Data fetching =====

        export let activeSessionsByProject = {};

        export async function refreshActiveSessions() {
            try {
                const r = await fetch(`${API}/api/sessions`);
                const j = await r.json();
                const map = {};
                for (const s of (j.items || [])) {
                    const name = (s.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'unknown';
                    if (!map[name]) map[name] = [];
                    map[name].push(s.pid);
                }
                activeSessionsByProject = map;
            } catch {
                // Keep the last known session map on transient fetch failures.
            }
        }


        // ===== Daemon freshness banner =====
        // /api/boot (#326) answers "is the running process older than the code
        // on disk?" — assets are import-baked, so a stale daemon serves a stale
        // dashboard too. Checked at load + every 5 minutes; the button drives
        // POST /api/server/restart (token-aware) and reloads once the
        // replacement answers /api/ping.
        async function checkDaemonFreshness() {
            try {
                const r = await fetch(`${API}/api/boot`);
                if (!r.ok) return;
                const { stale } = await r.json();
                const existing = document.getElementById('freshnessBar');
                if (!stale) { if (existing) existing.remove(); return; }
                if (existing) return;
                const bar = document.createElement('div');
                bar.id = 'freshnessBar';
                bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;display:flex;gap:12px;align-items:center;justify-content:center;padding:7px 16px;font-size:13px;background:#2a2210;color:#ffd166;border-bottom:1px solid #c98500';
                const msg = document.createElement('span');
                msg.textContent = 'الخادم يشغّل نسخة أقدم من الكود الموجود على القرص — أعد التشغيل لاستلام التحديث';
                const btn = document.createElement('button');
                btn.textContent = 'إعادة تشغيل الخادم';
                btn.style.cssText = 'background:#c98500;color:#161718;border:0;border-radius:6px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit';
                btn.onclick = async () => {
                    btn.disabled = true;
                    btn.textContent = 'يعيد التشغيل…';
                    try {
                        await fetch(`${API}/api/server/restart`, { method: 'POST', headers: await destructiveHeaders() });
                    } catch {
                        // The dying server may drop the connection mid-response;
                        // the ping loop below decides success or failure.
                    }
                    // Poll until the replacement answers, then hard-reload so
                    // the fresh assets load. Give up after ~20s.
                    for (let i = 0; i < 28; i++) {
                        await new Promise(res => setTimeout(res, 700));
                        try {
                            const p = await fetch(`${API}/api/ping`, { signal: AbortSignal.timeout(600) });
                            if (p.ok) { location.reload(); return; }
                        } catch { /* still swapping */ }
                    }
                    btn.textContent = 'تعذّرت الإعادة — أعد تشغيل الخادم يدويًا';
                };
                bar.append(msg, btn);
                document.body.prepend(bar);
            } catch { /* daemon predates /api/boot or busy — try next beat */ }
        }
        checkDaemonFreshness();
        setInterval(checkDaemonFreshness, 5 * 60 * 1000);
