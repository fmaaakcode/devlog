        import { data, setData, activeProject, setActiveProject, setHeaderBuilt, setCachedTree, logFilter, fullRenderNeeded, setFullRenderNeeded, lastDataHash, setLastDataHash } from "./dashboard-state.js";
        import { API, esc, timeStr, tagClass, tagLabels, tagSummary, filterGroups, filterLabels, resolveTagDisplay, refreshActiveSessions } from "./dashboard-core.js";
        import { renderSidebar, getProjectTags, patchHeader, patchLibraries, vulnCache } from "./dashboard-project.js";
        import { renderChangesCard, renderActivePlanCard, updateSidebarStats, renderProject, buildTodosHtml } from "./dashboard-panels.js";
        import { buildEventsHtml, buildDocsHtml, buildSecurityHtml } from "./dashboard-tree-ws.js";

        // Landing mode (#373): until a project is opened, the dashboard lives
        // off /api/projects-summary (a few KB); opening one fetches only that
        // project's slices (R3 #4). The old full-/api/data mode and its
        // dataIsFull flag were removed by the R3 review — the flag could never
        // become true, so the whole full-store path was dead code.
        // The sidebar's single source in BOTH modes (#379): counts, recency and
        // the vuln verdict all come from /api/projects-summary — the client no
        // longer re-derives any of them from raw tags.
        export let summaryLastActivity = {};     // { project → epoch ms }
        export let summaryTagCounts = {};        // { project → tag count }
        export let summaryVulnClass = {};        // { project → '' | vuln-safe | vuln-warn | vuln-danger }
        export let summaryOrphans = 0;           // store names with no registry entry (#375)
        export let summaryTombstones = 0;        // projects gone from disk 30+ days (#380)
        export let summaryUntagged = 0;          // quiet sessions that wrote code but stored no tags (#434)
        export let summaryUntaggedBy = {};       // { project → its untagged-session count } — feeds the tooltip (#447)

        function applySummary(j) {
            summaryLastActivity = {};
            summaryTagCounts = {};
            summaryVulnClass = {};
            summaryUntaggedBy = {};
            const projects = {};
            for (const p of (j.projects || [])) {
                projects[p.name] = {
                    name: p.name, path: p.path, language: p.language,
                    framework: p.framework, libraries: [],
                };
                summaryLastActivity[p.name] = p.lastActivity || 0;
                summaryTagCounts[p.name] = p.tags || 0;
                summaryVulnClass[p.name] = p.vulnClass || '';
                if (p.untagged > 0) summaryUntaggedBy[p.name] = p.untagged;
            }
            // Coerced: these land inside renderMaintRow's innerHTML.
            summaryOrphans = Number(j.orphans) || 0;
            summaryTombstones = Number(j.tombstones) || 0;
            summaryUntagged = Number(j.untagged) || 0;
            return projects;
        }

        export async function fetchSummary() {
            try {
                const [res] = await Promise.all([
                    fetch(`${API}/api/projects-summary`),
                    refreshActiveSessions(),
                ]);
                const projects = applySummary(await res.json());
                // Order guard (#397, extended for R3 #4): a project may have been
                // OPENED (lazy view) while this landing-mode fetch was in flight.
                // Overwriting `data` with these empty arrays would blank the open
                // project's cards. Only take over `data` while truly on the landing
                // screen; the summary maps + sidebar refresh either way.
                if (!activeProject) {
                    setData({ projects, events: [], tags: [], plans: [], worklog: [] });
                }
                renderSidebar();
            } catch {
                // Server unreachable: keep the last rendered sidebar.
            }
        }

        // Per-item open/closed judgments for the active project — the server's
        // verdict (#379), same resolvers as ask:open and the release guard.
        // Cards render from this instead of re-judging tags client-side.
        let verdicts = null;         // last SUCCESSFUL verdicts payload (carries its own .project)
        let verdictsStale = false;   // true when the latest refresh failed but we kept the old snapshot
        export async function refreshVerdicts() {
            if (!activeProject) { verdicts = null; verdictsStale = false; return; }
            try {
                // Timeout so a stalled-but-connected server can't wedge the render
                // path (#402); on abort/failure we fall through to the stale/last-good
                // snapshot handling below (#414).
                const r = await fetch(`${API}/api/verdicts/${encodeURIComponent(activeProject)}`, { signal: AbortSignal.timeout(5000) });
                if (!r.ok) throw new Error(`verdicts ${r.status}`);
                verdicts = await r.json();
                verdictsStale = false;
            } catch {
                // Transient failure: KEEP the last good snapshot (its own .project
                // gates reuse in currentVerdicts) and just mark it stale. Nulling it
                // made the stats/tasks cards flash green zeros — a false all-clear —
                // while the security card defaulted the same gap to "open" (#394).
                verdictsStale = true;
            }
        }

        // Single source for "what verdicts should this render use, and are they stale?"
        // `v` is null ONLY when we've never successfully fetched verdicts for the active
        // project — callers must then default items to OPEN, never to a green zero (#414).
        // `stale` is true whenever the latest refresh failed, whether we're showing a
        // kept snapshot (v set) or the assumed-open fallback (v null) — both are degraded.
        export function currentVerdicts() {
            const v = verdicts && verdicts.project === activeProject ? verdicts : null;
            return { v, stale: verdictsStale };
        }

        // Render-relevant fingerprint of a store snapshot for the active project —
        // fetchProjectView skips no-op re-renders when it matches lastDataHash.
        function computeRenderHash(newData) {
            const proj = newData.projects?.[activeProject];
            const lastEv = newData.events?.length ? newData.events[newData.events.length - 1] : null;
            const lastTag = newData.tags?.length ? newData.tags[newData.tags.length - 1] : null;
            const projectPlans = (newData.plans || []).filter(p => p.project === activeProject);
            return JSON.stringify({
                tags: newData.tags?.length, lastTagId: lastTag?.id,
                events: newData.events?.length, lastEventId: lastEv?.id,
                projects: Object.keys(newData.projects || {}).length,
                // name@version per lib (not just the count): updating a dep changes the
                // version but not the count, and the deps button/badges must re-patch.
                libs: proj?.libraries?.map(l => `${l.name}@${l.version}`).join(","),
                vulnScan: proj?.vulnScanDate,
                lang: proj?.language, framework: proj?.framework, runtime: proj?.runtime,
                files: proj?.totalFiles, fileExts: proj?.files, desc: proj?.description,
                plans: projectPlans.length,
                planSteps: projectPlans.map(p => { const vs = p.steps.filter(s => !s.dropped); return `${p.title}|${vs.filter(s => s.completed).length}/${vs.length}`; }).join(";"),
            });
        }

        // R3 review: with the store no longer cached client-side, a failed
        // FIRST fetch used to leave a silently blank project pane (welcome is
        // already hidden by selectProject, and the catch kept "the last
        // rendered view" — which didn't exist). Surface the failure instead,
        // with a retry that doesn't depend on a WS pulse coming back.
        function showViewError(name) {
            const host = document.getElementById("projectView");
            if (!host || document.getElementById("viewErrorBar")) return;
            const bar = document.createElement("div");
            bar.id = "viewErrorBar";
            bar.style.cssText = "margin:8px 12px;padding:9px 14px;border:1px solid var(--pink);border-radius:8px;color:var(--pink);font-size:0.85em;display:flex;gap:12px;align-items:center;flex:0 0 auto";
            const msg = document.createElement("span");
            msg.textContent = `تعذّر جلب بيانات المشروع "${name}" من الخادم`;
            const btn = document.createElement("button");
            btn.textContent = "أعد المحاولة";
            btn.className = "confirm-btn";
            btn.onclick = () => { btn.disabled = true; refreshActiveView(true).finally(() => { btn.disabled = false; }); };
            bar.append(msg, btn);
            host.prepend(bar);
        }

        // History window (R8 perf): the switch render is O(rendered DOM), and
        // rendering a project's ENTIRE history froze the main thread ~300ms at
        // 1474 tags (measured over CDP; an empty project renders in 14ms) —
        // and got worse with every session. Fetch only the latest window; the
        // server always keeps security/bug/outdated rows so the security card
        // stays complete, and the todos card renders from verdicts (full
        // history, server-side) either way. "عرض كامل التاريخ" in the tags
        // card lifts the window for that project until reload.
        const HISTORY_LIMIT = 150;
        const fullHistory = new Set();   // projects the user expanded
        export function expandHistory(name) { fullHistory.add(name); }

        // R3 #4: open one project WITHOUT pulling the whole store. Fetches the
        // project's profile + its tags/events/plans slices and overlays them on
        // the summary-level projects map. `data` then holds exactly one
        // project's history — every card already filters by activeProject, so
        // the renders are byte-identical to full mode.
        export async function fetchProjectView(name, forceRender) {
            try {
                // R7 perf: the switch render is gated ONLY on the two fast,
                // project-sized calls it actually consumes — project-view (~6ms)
                // and verdicts (~6ms). The whole-registry summary (grows with
                // project count) and the active-sessions probe (a ~420ms
                // PowerShell/WMI process snapshot on Windows) used to sit in this
                // same Promise.all, so EVERY project switch blocked ~440ms on
                // work the project cards never read. They moved to a background
                // refresh (refreshSidebarAsync) that patches the sidebar a beat
                // later without making the switch wait. Measured on the live
                // daemon: sessions 421ms vs project-view/verdicts 6ms each.
                const limit = fullHistory.has(name) ? 0 : HISTORY_LIMIT;
                const [viewRes] = await Promise.all([
                    fetch(`${API}/api/project-view/${encodeURIComponent(name)}?limit=${limit}`),
                    refreshVerdicts(),
                ]);
                // The user may have clicked another project while this was in
                // flight — applying a stale view would render the wrong project.
                if (activeProject !== name) return;
                if (viewRes.status === 404) {
                    // Deleted project or a dead #project= deep-link: back to landing.
                    setActiveProject(null);
                    history.replaceState(null, '', location.pathname);
                    document.getElementById("projectView").style.display = "none";
                    document.getElementById("welcome").style.display = "flex";
                    await fetchSummary();
                    return;
                }
                const view = await viewRes.json();
                // Reuse the in-memory summary-level projects map (from the last
                // summary fetch / WS pulse) and overlay just THIS project's full
                // profile; the background refresh below reconciles the rest.
                const projects = { ...(data.projects || {}) };
                projects[name] = view.profile;
                // Server-stored scan results are at least as fresh as any manual-scan
                // snapshot (runVulnScan persists BEFORE broadcasting/responding), so
                // overwrite the in-memory cache. A stale vulnCache entry used to keep
                // winning over the fresh profile in patchLibraries and pin the deps
                // button on "outdated" after a library update until a full page reload.
                if (view.profile?.vulnResults) vulnCache[name] = view.profile.vulnResults;
                // tagsTotal rides along for the "عرض كامل التاريخ" affordance —
                // absent (older payloads) it degrades to the loaded count.
                const newData = {
                    projects, events: view.events || [], tags: view.tags || [], plans: view.plans || [], worklog: [],
                    tagsTotal: view.tagsTotal ?? (view.tags || []).length,
                };
                const newHash = computeRenderHash(newData);
                const changed = newHash !== lastDataHash;
                setData(newData);
                setLastDataHash(newHash);
                document.getElementById("viewErrorBar")?.remove();
                renderSidebar();
                if (fullRenderNeeded || forceRender) {
                    setFullRenderNeeded(false);
                    renderProject();
                } else if (changed) {
                    patchHeader();
                    updateCards();
                }
                // Off the critical path: refresh the other-project sidebar counts
                // + active-session indicators without making the switch wait.
                refreshSidebarAsync();
            } catch {
                // Server unreachable. Keep whatever is rendered, but SAY so —
                // on a first selection there is nothing rendered to keep.
                if (activeProject === name) showViewError(name);
            }
        }

        // Background sidebar refresh (R7 perf): the whole-registry summary and
        // the expensive active-sessions probe, pulled OFF the switch's critical
        // path. Fired after the project already rendered; updates the sidebar in
        // place when it lands. A sequence guard drops a slow response that
        // arrives after a newer switch/pulse started, so it can't clobber the
        // fresher summary map.
        let sidebarRefreshSeq = 0;
        async function refreshSidebarAsync() {
            const seq = ++sidebarRefreshSeq;
            try {
                const [sumRes] = await Promise.all([
                    fetch(`${API}/api/projects-summary`),
                    refreshActiveSessions(),
                ]);
                if (seq !== sidebarRefreshSeq) return; // a newer refresh won
                const projects = applySummary(await sumRes.json());
                // applySummary yields summary-level entries (libraries: []); keep
                // the active project's FULL profile so its cards don't downgrade
                // to the lightweight shape (#397).
                if (activeProject && data.projects?.[activeProject]) {
                    projects[activeProject] = data.projects[activeProject];
                }
                setData({ ...data, projects });
                renderSidebar();
            } catch {
                // Transient failure: keep the current sidebar; next pulse resyncs.
            }
        }

        // The one "refresh whatever is on screen" decision (R3 review): an open
        // project refreshes its own lazy view, the landing screen refreshes the
        // summary. Every caller (WS pulse, cleanups, rename, ignore, delete)
        // routes through here — the per-site conditionals had already drifted
        // apart (some forgot the open-project arm and blanked its cards).
        export function refreshActiveView(forceRender) {
            return activeProject ? fetchProjectView(activeProject, forceRender) : fetchSummary();
        }

        function flashCard(id) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove('card-updated');
                void el.offsetWidth;
                el.classList.add('card-updated');
            }
        }

        // Track previous content hash per card — only flash on actual change.
        // `flash:false` is for USER-driven re-renders (tab switches): the same
        // card changing under the user's own click must not glow like a live
        // data update. Returns true when the DOM was actually rewritten, so
        // callers that bind listeners into the fresh HTML know whether to
        // rebind (renderChangesCard) — a skipped write keeps the old nodes
        // and their listeners intact.
        const cardHashes = {};
        export function updateCard(id, html, flash = true) {
            const el = document.getElementById(id);
            if (!el) return false;
            const prev = cardHashes[id];
            cardHashes[id] = html;
            if (prev === html) return false; // no change — skip
            el.innerHTML = html;
            if (flash && prev !== undefined) flashCard(id); // don't flash on first render
            return true;
        }

        // Shared tags-card builder — ONE definition for both the full render and
        // the surgical updateCards/WS path, like buildEventsHtml/buildTodosHtml
        // (#229). The two inline copies had already drifted: resolveTagDisplay
        // (#N → the closed item's text) ran on the full render only, while the
        // item-new highlight ran on the surgical path only. Returns the complete
        // card (header + filter row + scroll container + rows).
        export function buildTagsHtml(tags) {
            const head = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">التاقات</div>`;
            if (!tags || tags.length === 0) {
                return `${head}<div style="color:var(--text2);font-size:0.7em">لا توجد تاقات</div>`;
            }
            const filtered = logFilter === "all" ? tags : tags.filter(t => filterGroups[logFilter]?.includes(t.tag));
            const projectPlans = (data.plans || []).filter(p => p.project === activeProject);
            let h = `${head}<div class="log-filters">`;
            for (const [key, label] of Object.entries(filterLabels)) {
                const count = key === "all" ? tags.length : tags.filter(t => filterGroups[key].includes(t.tag)).length;
                if (key !== "all" && count === 0) continue;
                h += `<button class="log-filter${logFilter === key ? ' active' : ''}" data-action="set-log-filter" data-key="${esc(key)}">${esc(label)} <span class="tab-badge tab-badge-default">${count}</span></button>`;
            }
            h += '</div><div style="overflow-y:auto;flex:1;min-height:0">';
            for (const t of filtered) {
                const tc = tagClass(t.tag);
                const display = resolveTagDisplay(t, tags, projectPlans);
                const sec = t.tag === 'security'
                    ? ` data-action="show-vulns-tag" data-project="${esc(activeProject)}" data-content="${esc(t.content)}" style="cursor:pointer;text-decoration:underline dotted"`
                    : '';
                const ttl = t.tag === 'security' ? `${display} — اضغط لتفاصيل الثغرات` : display;
                h += `<div class="log-item item-new${t.breaking ? ' is-breaking' : ''}">
                    <div class="log-bar bar-${tc}"></div>
                    <span class="log-tag tag-${tc}">${esc(tagLabels[t.tag] || t.tag)}</span>
                    <span class="log-content"${sec} title="${esc(ttl)}">${esc(tagSummary(display))}</span>
                    <span class="log-time">${timeStr(t.timestamp)}</span>
                </div>`;
            }
            // History window (R8 perf): older rows exist server-side only —
            // the button lifts the window for this project (expand-history).
            if ((data.tagsTotal || 0) > tags.length) {
                h += `<button class="log-filter" data-action="expand-history" style="width:100%;margin-top:4px">عرض كامل التاريخ (${data.tagsTotal} تاق)</button>`;
            }
            return `${h}</div>`;
        }

        function updateCards() {
            const tags = getProjectTags();
            const plans = (data.plans || []).filter(p => p.project === activeProject);
            const p = data.projects[activeProject];

            // Update events card — shared builder, identical to the full render.
            updateCard('eventsCard', buildEventsHtml(data.events, activeProject));

            // Update tags card — shared builder, identical to the full render.
            updateCard('cardTags', buildTagsHtml(tags));

            // Update docs/memory
            if (p) updateCard('cardDocs', buildDocsHtml(p));

            // Update security
            updateCard('cardSecurity', `<div style="overflow-y:auto;flex:1;min-height:0">${buildSecurityHtml(tags, p)}</div>`);

            // Update todos — shared builder, identical to the full render.
            updateCard('cardTodos', buildTodosHtml(tags));

            // Refresh changes card (async, fetches from /api/changes)
            renderChangesCard(activeProject);
            // Refresh active-plan card (data.plans live-updated by tags WS event)
            renderActivePlanCard(activeProject);

            // Surgical header update
            patchHeader();
            updateSidebarStats();
        }

        export async function rescanProject(name, btn) {
            btn.classList.add("loading");
            btn.textContent = "جاري المسح...";
            try {
                await fetch(`${API}/api/scan/${encodeURIComponent(name)}`, { method: "POST" });
                setHeaderBuilt(false);
                setCachedTree(null);
                await fetchProjectView(name, true);
            } catch {
                // Scan failed or timed out — the button reset below re-arms it.
            }
            btn.classList.remove("loading");
            btn.textContent = "إعادة مسح";
        }

        function setVulnStatus(panel, msg, color = 'var(--text2)', spinner = false) {
            const spin = spinner ? '<span class="vuln-spinner"></span>' : '';
            // esc(msg): msg can carry err.message (see vulnScan catch) — never raw into innerHTML (R3 P5)
            panel.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-size:0.78em;color:${color}">${spin}<span>${esc(msg)}</span></div>`;
            panel.style.display = "flex";
        }

        export async function vulnScan(name, btn) {
            btn.classList.add("loading");
            btn.textContent = "جاري الفحص...";
            const panel = document.getElementById("vuln-panel");
            setVulnStatus(panel, "جاري الاتصال بسيرفر الفحص...", 'var(--text2)', true);
            try {
                const res = await fetch(`${API}/api/vuln/${encodeURIComponent(name)}`);
                if (!res.ok) {
                    setVulnStatus(panel, `استجابة غير متوقعة من السيرفر (HTTP ${res.status})`, 'var(--pink)');
                    btn.classList.remove("loading"); btn.textContent = "فحص أمني"; return;
                }
                setVulnStatus(panel, "تم استلام النتائج، جاري التحليل...", 'var(--text2)', true);
                let d;
                try { d = await res.json(); }
                catch {
                    setVulnStatus(panel, "فشل قراءة استجابة السيرفر (JSON غير صالح)", 'var(--pink)');
                    btn.classList.remove("loading"); btn.textContent = "فحص أمني"; return;
                }

                // Save results to cache and re-render libraries
                if (d.libraries?.results) {
                    vulnCache[name] = {};
                    for (const pkg of d.libraries.results) {
                        vulnCache[name][pkg.name] = pkg;
                    }
                }

                // Re-render libraries with vuln colors
                const p = data.projects[name];
                if (p) patchLibraries(p);

                // Show runtime + summary in panel
                let h = '';
                if (d.runtime) {
                    const r = d.runtime;
                    const icon = r.icon === "check" ? "✅" : r.icon === "x" ? "❌" : "⚠️";
                    const color = r.icon === "check" ? "var(--emerald)" : "var(--pink)";
                    h += `<div style="display:flex;align-items:center;gap:8px;font-size:0.78em">
                        <span>${icon}</span>
                        <span style="color:${color};font-weight:600">${esc(r.name)} ${esc(r.version || '')}</span>
                        <span style="color:var(--text2)">${esc(r.message)}</span>
                        ${r.eol ? '<span style="color:var(--pink);font-weight:600;font-size:0.85em">⛔ EOL</span>' : ''}
                    </div>`;
                }
                if (d.libraries?.summary) {
                    const s = d.libraries.summary;
                    h += `<div style="display:flex;gap:12px;font-size:0.75em;font-weight:600;${d.runtime ? 'margin-top:6px' : ''}">
                        <span style="color:var(--emerald)">✅ ${s.safe} آمنة</span>
                        ${s.update > 0 ? `<span style="color:var(--pink)">❌ ${s.update} تحتاج تحديث</span>` : ''}
                        ${s.danger > 0 ? `<span style="color:var(--gold)">⚠️ ${s.danger} خطيرة</span>` : ''}
                    </div>`;
                }
                if (!d.libraries?.results?.length && !d.runtime) {
                    h = '<div style="color:var(--text2);font-size:0.8em">لا توجد مكتبات أو runtime لفحصها</div>';
                }
                if (h) { panel.innerHTML = h; panel.style.display = "flex"; }
                else { panel.style.display = "none"; }
            } catch (err) {
                const msg = err?.message ? `فشل الاتصال بسيرفر الفحص — ${err.message}` : 'فشل الاتصال بسيرفر الفحص (تأكد من تشغيل خدمة الفحص)';
                setVulnStatus(panel, msg, 'var(--pink)');
            }
            btn.classList.remove("loading");
            btn.textContent = "فحص أمني";
        }

        // ===== Sidebar =====

        // Threshold beyond which a project is considered "inactive" — kept low
        // (7 days) because a sidebar split that stays full of stale projects
        // defeats the point.
        export const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

