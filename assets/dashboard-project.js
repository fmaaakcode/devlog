        import { data, activeProject, setActiveProject, headerBuilt, setHeaderBuilt, setCachedTree, setFullRenderNeeded } from "./dashboard-state.js";
        import { API, esc, safeHref, langColors, destructiveHeaders, uiAlert, uiConfirm, uiPrompt, activeSessionsByProject } from "./dashboard-core.js";
        import { summaryTagCounts, summaryVulnClass, summaryLastActivity, summaryTombstones, ACTIVE_WINDOW_MS, fetchProjectView, refreshActiveView } from "./dashboard-data.js";
        import { patchSessions } from "./dashboard-panels.js";
        import { t as tr, uiDir } from "./dashboard-i18n.js";
        import { trendsSvg, TREND_SERIES } from "./dashboard-trends.js";

        function renderProjectItem(name) {
            const p = data.projects[name];
            // Counts + vuln verdict come from the summary maps in both modes
            // (#379) — the server judges, the sidebar displays.
            const tagCount = summaryTagCounts[name] || 0;
            const color = langColors[p.language] || langColors.default;
            const vulnCls = summaryVulnClass[name] || '';
            const title = vulnCls === 'vuln-danger' ? tr("side.vulnDanger")
                        : vulnCls === 'vuln-warn' ? tr("side.vulnWarn")
                        : vulnCls === 'vuln-safe' ? tr("side.vulnSafe")
                        : '';
            const livePids = activeSessionsByProject[name] || [];
            const liveDot = livePids.length
                ? `<span class="project-live" title="${tr("side.liveTitle", { pids: livePids.join(', ') })}"></span>`
                : '';
            const itemTitle = title || (livePids.length ? tr("side.liveShort", { pids: livePids.join(', ') }) : '');
            return `<div class="project-item ${activeProject === name ? 'active' : ''} ${vulnCls}" data-action="select-project" data-project="${esc(name)}" ${itemTitle ? `title="${esc(itemTitle)}"` : ''}>
                <span class="project-dot" style="background:${color}"></span>
                <span class="project-item-name">${esc(name)}</span>
                <span class="project-item-count">${tagCount}</span>
                ${liveDot}
                <button class="project-export" data-action="export-project" data-project="${esc(name)}" title="${tr("side.exportTitle")}">⤓</button>
                <button class="project-rename" data-action="rename-project" data-project="${esc(name)}" title="${tr("side.renameTitle")}">✎</button>
                <button class="project-delete" data-action="delete-project" data-project="${esc(name)}" title="${tr("side.deleteTitle")}">✕</button>
            </div>`;
        }

        // Hash guard (round-8 UI): renderSidebar runs on EVERY WS pulse and
        // background sidebar refresh; rewriting identical innerHTML still tears
        // the project cards down — killing :hover mid-interaction and resetting
        // the list scroll. Write only when the markup actually changed.
        const sidebarHashes = {};
        function setListHtml(el, key, html) {
            if (sidebarHashes[key] === html) return;
            sidebarHashes[key] = html;
            el.innerHTML = html;
        }

        export function renderSidebar() {
            const elActive = document.getElementById("projectListActive");
            const elOther = document.getElementById("projectListOther");
            const names = Object.keys(data.projects);
            if (names.length === 0) {
                setListHtml(elActive, "active", `<div class="sidebar-empty">${tr("side.empty")}</div>`);
                setListHtml(elOther, "other", '');
                // #401: the orphan/tombstone sweep must still render with an EMPTY
                // registry — that corrupted-registry case (names in the stores but no
                // project entries) is exactly what it was built for. Running it here
                // also clears a stale row left over from when projects existed.
                renderMaintRow();
                return;
            }
            // Recency ships precomputed in the summary (#379) — both modes.
            const lastActivity = summaryLastActivity || {};
            const now = Date.now();
            const isActive = (name) => {
                if ((activeSessionsByProject[name] || []).length > 0) return true;
                return (now - (lastActivity[name] || 0)) <= ACTIVE_WINDOW_MS;
            };
            names.sort((a, b) => (lastActivity[b] || 0) - (lastActivity[a] || 0) || a.localeCompare(b));
            const active = names.filter(isActive);
            const other = names.filter(n => !isActive(n));

            const renderCard = (title, list, emptyMsg) => {
                const items = list.length
                    ? list.map(renderProjectItem).join("")
                    : `<div class="project-list-empty">${esc(emptyMsg)}</div>`;
                return `<div class="project-list-title">
                    <span>${esc(title)}</span>
                    <span class="count">${list.length}</span>
                </div>${items}`;
            };

            setListHtml(elActive, "active", renderCard(tr("side.active"), active, tr("side.activeEmpty")));
            setListHtml(elOther, "other", renderCard(tr("side.other"), other, tr("side.otherEmpty")));
            renderMaintRow();
        }

        // Sweep buttons (#375/#380) — visible only when there's something to
        // clean; counts arrive with the summary in both modes.
        // The orphan-names sweep and the untagged/partially-tagged session
        // counters (#434/#558) were pulled from this row pending a redesign of
        // that surface; their server APIs and summary fields are intact.
        function renderMaintRow() {
            const el = document.getElementById('maintRow');
            if (!el) return;
            const btn = (action, label) =>
                `<button data-action="${action}" style="width:100%;text-align:${uiDir() === 'rtl' ? 'right' : 'left'};background:none;border:1px dashed var(--border);border-radius:6px;color:var(--text2);font-size:0.7em;padding:5px 10px;cursor:pointer;margin-top:6px">${label}</button>`;
            let h = '';
            if (summaryTombstones > 0) h += btn('cleanup-tombstones', tr("maint.tombstones", { n: summaryTombstones }));
            // Always-on: fold a bundle exported on another machine into this
            // store (the ⤓ button on each project row produces that file).
            h += btn('import-project', tr("maint.import"));
            el.innerHTML = h;
            el.style.display = h ? '' : 'none';
        }

        export async function cleanupTombstones() {
            if (!(await uiConfirm(tr("maint.tombConfirm"), { okText: tr("core.deleteForever") }))) return;
            try {
                const r = await fetch(`${API}/api/cleanup-tombstones`, {
                    method: 'POST',
                    headers: await destructiveHeaders({ 'Content-Type': 'application/json' }),
                    body: '{}',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { uiAlert(j.error || tr("maint.sweepFail")); return; }
                uiAlert(j.removed?.length ? tr("maint.removed", { list: j.removed.join('، ') }) : tr("maint.nothing"));
            } catch { uiAlert(tr("err.connGeneric")); }
            refreshActiveView(true);
        }

        // Import a bundle produced by the ⤓ export button on another machine.
        // The heavy validation lives server-side (/api/project-import); here we
        // only pre-check the kind so an obviously wrong file fails before the
        // confirm dialog, and summarize what the merge will do.
        export function importProjectBundle() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                let bundle;
                try { bundle = JSON.parse(await file.text()); } catch { uiAlert(tr("imp.badJson")); return; }
                if (bundle?.kind !== 'devlog-project-export') { uiAlert(tr("imp.wrongKind")); return; }
                const counts = tr("imp.counts", { tags: (bundle.tags || []).length, events: (bundle.events || []).length, plans: (bundle.plans || []).length });
                const mode = data.projects[bundle.project]
                    ? tr("imp.modeMerge")
                    : tr("imp.modeNew");
                if (!(await uiConfirm(tr("imp.confirm", { project: bundle.project, counts, mode }), { okText: tr("imp.ok"), danger: false }))) return;
                try {
                    const r = await fetch(`${API}/api/project-import`, {
                        method: 'POST',
                        headers: await destructiveHeaders({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify(bundle),
                    });
                    const j = await r.json().catch(() => ({}));
                    if (!r.ok) { uiAlert(j.error || tr("imp.fail")); return; }
                    const a = j.added || {};
                    uiAlert(tr("imp.done", { tags: a.tags || 0, events: a.events || 0, plans: a.plans || 0, steps: a.planSteps || 0, archive: j.archive?.added || 0, skipped: j.skipped || 0, renumbered: j.renumbered || 0 }), tr("imp.title"));
                    location.reload();
                } catch (e) { uiAlert(tr("err.connServer", { msg: e.message })); }
            };
            input.click();
        }

        export async function renameProject(name) {
            const next = await uiPrompt(tr("ren.prompt", { name }), name, { title: tr("ren.title"), okText: tr("ren.ok") });
            if (next === null) return;                 // cancelled
            const newName = next.trim();
            if (!newName || newName === name) return;
            try {
                const res = await fetch(`${API}/api/project/${encodeURIComponent(name)}/rename`, {
                    method: "POST",
                    headers: await destructiveHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({ newName }),
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) { uiAlert(result.error || tr("ren.fail")); return; }
                // Note what the server actually did (folder + memory) so the user
                // knows whether the on-disk folder moved and if any memory card
                // was left behind (not overwritten at the destination).
                const bits = [];
                if (result.movedFolder) bits.push(tr("ren.movedFolder", { path: result.newPath }));
                const mv = result.memory?.moved?.length || 0;
                const sk = result.memory?.skipped?.length || 0;
                if (mv) bits.push(tr("ren.movedMem", { n: mv }));
                if (sk) bits.push(tr("ren.skippedMem", { n: sk }));
                if (bits.length) console.log("[rename]", bits.join(" · "));
                if (sk) uiAlert(tr("ren.doneSkipped", { n: sk }));
                // The WS "rename" broadcast refreshes data; switch selection if needed.
                if (activeProject === name) { setActiveProject(newName); setHeaderBuilt(false); setCachedTree(null); }
                await refreshActiveView(true);
            } catch { uiAlert(tr("err.connGeneric")); }
        }

        export async function deleteProject(name) {
            if (!(await uiConfirm(tr("del.confirm", { name }), { okText: tr("del.ok") }))) return;
            try {
                const res = await fetch(`${API}/api/project/${encodeURIComponent(name)}`, { method: "DELETE", headers: await destructiveHeaders() });
                if (res.ok) {
                    delete data.projects[name];
                    data.tags = (data.tags || []).filter(t => t.project !== name);
                    data.plans = (data.plans || []).filter(p => p.project !== name);
                    data.events = (data.events || []).filter(e => e.project !== name);
                    if (activeProject === name) {
                        setActiveProject(Object.keys(data.projects)[0] || "");
                        setHeaderBuilt(false);
                        setCachedTree(null);
                        if (activeProject) {
                            // R3 review: the store holds only the DELETED project's
                            // slices in lazy mode — rendering the successor from it
                            // gave a hollow view (summary-stub header, empty cards).
                            // Fetch the successor's own view; it refreshes verdicts,
                            // sidebar and render in one pass.
                            fetchProjectView(activeProject, true);
                        } else {
                            document.getElementById("projectView").style.display = "none";
                            document.getElementById("welcome").style.display = "flex";
                            document.getElementById("topbarLeft").innerHTML = "";
                            document.getElementById("topbar").classList.remove("has-project");
                            renderSidebar();
                        }
                    } else {
                        // The summary maps still hold the deleted project —
                        // refetch instead of patching them by hand.
                        refreshActiveView(true);
                    }
                }
            } catch {
                // Delete request failed — sidebar stays as-is, user can retry.
            }
        }

        export function selectProject(name) {
            setActiveProject(name);
            setFullRenderNeeded(true);
            setHeaderBuilt(false);
            setCachedTree(null);
            document.getElementById("welcome").style.display = "none";
            document.getElementById("projectView").style.display = "flex";
            const newHash = name ? `#project=${encodeURIComponent(name)}` : '';
            if (location.hash !== newHash) history.replaceState(null, '', newHash || location.pathname);
            // Smart auto-rescan if manifests changed since last scan (server fires async, broadcasts via WS)
            fetch(`${API}/api/check-stale/${encodeURIComponent(name)}`, { method: "POST" }).catch(() => {
                // Fire-and-forget: staleness check is opportunistic.
            });
            // The client holds only the summary (or another project's slices) —
            // R3 #4: fetch just THIS project's view; it renders sidebar +
            // project once it lands, and surfaces a retry bar on failure.
            fetchProjectView(name, true);
        }

        export function projectFromHash() {
            const m = location.hash.match(/project=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        }

        export function getProjectTags() {
            return (data.tags || []).filter(t => t.project === activeProject)
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        // ===== Main render =====

        // Surgical update helper — only touches DOM if value changed, then flashes
        function patch(el, newText, flashClass = 'val-flash') {
            if (!el) return;
            const old = el.textContent;
            if (old === String(newText)) return;
            el.textContent = newText;
            el.classList.remove('val-flash', 'val-flash-pink', 'badge-new');
            void el.offsetWidth; // force reflow
            el.classList.add(flashClass);
        }

        // headerBuilt moved to dashboard-state.js (R3 #3) — data.js resets it too.

        // Shared about-button state (#229). buildHeaderOnce renders it and
        // patchHeader live-refreshes it — both must agree on the class + title,
        // so the rule lives here once instead of in two literals that can drift.
        function aboutBtnAttrs(hasAbout) {
            return {
                cls: `about-btn ${hasAbout ? 'has-about' : 'no-about'}`,
                title: hasAbout ? tr("about.hover") : tr("about.missing"),
            };
        }

        // Shared git-badge markup (#492): buildHeaderOnce renders it and patchHeader
        // swaps it live when the remote changes, so both must agree on the markup —
        // same one-definition rule as aboutBtnAttrs. `data-remote` is the change key.
        function gitBadgeHtml(p) {
            const remote = p.gitRemote || '';
            if (remote) {
                const href = p.gitRepoSlug ? `https://github.com/${p.gitRepoSlug}` : safeHref(p.gitRemote);
                return `<a href="${esc(href)}" target="_blank" rel="noopener" id="hdr-git" data-remote="${esc(remote)}" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#0d1f2e;color:#7cc4f5;font-weight:600;text-decoration:none" title="${esc(remote)}">🔗 ${esc(p.gitRepoSlug || 'remote')}</a>`;
            }
            return `<span id="hdr-git" data-remote="" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a1a;color:var(--text2);font-weight:600" title="${tr("git.noRemote")}">📁 local</span>`;
        }

        export function buildHeaderOnce(p, tags) {
            const color = langColors[p.language] || langColors.default;
            const lastRelease = tags.find(t => t.tag === "release");
            const versionMatch = lastRelease?.content.match(/v[\d.]+/);
            const versionStr = versionMatch ? versionMatch[0] : "";

            // Topbar left: name + version + 3 small badges (lang, framework, runtime) + dependencies button
            document.getElementById("topbarLeft").innerHTML = `
                <span class="brand-name" id="hdr-name">${esc(p.name)}</span>
                <span class="brand-version" id="hdr-version" data-release-pop="1" data-action="open-releases" style="cursor:pointer;${versionStr ? '' : 'display:none'}" title="">${esc(versionStr)}</span>
                <span class="brand-version" id="hdr-next-release" data-action="open-release-preview" style="cursor:pointer;opacity:0.75" title="${tr("hdr.nextTitle")}">${tr("hdr.next")}</span>
                <span class="brand-version" id="hdr-client-report" data-action="open-client-report" style="cursor:pointer;opacity:0.85" title="${tr("hdr.clientReportTitle")}">${tr("hdr.clientReport")}</span>
                <span class="brand-version" id="hdr-model-stats" data-action="open-model-stats" style="cursor:pointer;opacity:0.85" title="${tr("hdr.modelStatsTitle")}">${tr("hdr.modelStats")}</span>
                <span class="deps-btn unknown" id="hdr-deps">
                    <span class="deps-dot"></span>
                    <span>dependencies</span>
                    <span class="deps-count" id="hdr-deps-count">0</span>
                    <div class="deps-popup" id="hdr-deps-popup"></div>
                </span>
                <span class="stats-btn" id="hdr-stats">
                    <span>stats</span>
                    <span class="stats-count" id="hdr-stats-count">0</span>
                    <div class="stats-popup" id="hdr-stats-popup"></div>
                </span>
                <span class="lang-badge" id="hdr-lang" style="background:${color}18; color:${color}">${esc(p.language)}</span>
                <span class="framework-badge" id="hdr-framework" style="background:#04201a;color:var(--emerald);${p.framework ? '' : 'display:none'}">${esc(p.framework || '')}</span>
                <span id="hdr-runtime" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#7c8cf5;font-weight:600;${p.runtime ? '' : 'display:none'}">${p.runtime ? `${esc(p.runtime.name || '')}${p.runtime.version ? ` ${esc(p.runtime.version)}` : ''}${p.runtime.edition ? ` · ${esc(p.runtime.edition)}` : ''}` : ''}</span>
                ${gitBadgeHtml(p)}
                <span id="hdr-sessions" data-action="open-sessions" data-project="${esc(p.name)}" style="display:none;font-size:0.7em;padding:2px 8px;border-radius:4px;background:#0d2e1f;color:var(--emerald);font-weight:600;cursor:pointer" title="${tr("hdr.sessionsTitle")}"></span>
            `;
            document.getElementById("topbar").classList.add("has-project");

            const hasAbout = !!(p.about?.trim());
            const ab = aboutBtnAttrs(hasAbout);
            // Description text and the about button are SEPARATE siblings: patchHeader
            // updates #hdr-desc-text only, so the about button survives live patches.
            // Container shows if there's a description OR an about to view.
            document.getElementById("projectHeader").innerHTML = `
                <div id="hdr-desc" style="font-size:0.8em;color:var(--text2);direction:${uiDir()};${(p.description || hasAbout) ? '' : 'display:none'}">
                    <span id="hdr-desc-text" dir="auto" style="${p.description ? '' : 'display:none'}">${esc(p.description || '')}</span>
                    <span class="${ab.cls}" data-about-btn="1" id="hdr-about-btn" title="${ab.title}">about</span>
                </div>
            `;
            setHeaderBuilt(true);
            patchLibraries(p);
            patchSessions(p.name);
            patchStatsButton(p, tags);
        }

        // Trends tab (#788): /api/trends rows cached per project so hovering
        // the tab doesn't refetch on every popup patch cycle.
        const trendsCache = {}; // { projectName: { at: ms, monthly } }
        const TRENDS_TTL_MS = 60_000;
        const TREND_LABELS = { opened: "statsPop.trendOpened", closed: "statsPop.trendClosed", released: "statsPop.trendReleased" };

        function setStatsTab(popup, tab) {
            for (const el of popup.querySelectorAll('[data-stats-tab]')) {
                const on = el.dataset.statsTab === tab;
                el.style.color = on ? 'var(--text)' : 'var(--text2)';
                el.style.borderBottom = on ? '2px solid var(--gold)' : '2px solid transparent';
            }
            for (const pane of popup.querySelectorAll('[data-stats-pane]')) {
                pane.style.display = pane.dataset.statsPane === tab ? '' : 'none';
            }
        }

        async function loadTrendsPane(popup, projectName) {
            const pane = popup.querySelector('[data-stats-pane="trends"]');
            if (!pane) return;
            const c = trendsCache[projectName];
            if (!c || Date.now() - c.at > TRENDS_TTL_MS) {
                const res = await fetch(`/api/trends?project=${encodeURIComponent(projectName)}`).then(r => r.json()).catch(() => null);
                trendsCache[projectName] = { at: Date.now(), monthly: res?.monthly || [] };
            }
            const svg = trendsSvg(trendsCache[projectName].monthly);
            if (!svg) {
                pane.innerHTML = `<div style="color:var(--text2);font-size:0.85em;padding:8px 0">${tr("statsPop.trendsEmpty")}</div>`;
                return;
            }
            const legend = TREND_SERIES.map(s =>
                `<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:2px;background:${s.color}"></span>${tr(TREND_LABELS[s.key])}</span>`
            ).join('');
            pane.innerHTML = `${svg}<div style="display:flex;gap:12px;justify-content:center;margin-top:6px;font-size:0.75em;color:var(--text2)">${legend}</div>`;
        }

        function statsNumbersHtml(p, tags) {
            const filesN = p.totalFiles || 0;
            const libsN = (p.libraries || []).length;
            const dirsN = (p.directories || []).length;
            const exts = Object.entries(p.files || {}).sort((a, b) => b[1] - a[1]);

            let html = '<div class="stats-grid">';
            html += `<div class="stats-row"><span class="stats-key">${tr("statsPop.files")}</span><span class="stats-value">${filesN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">${tr("statsPop.libs")}</span><span class="stats-value">${libsN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">${tr("statsPop.dirs")}</span><span class="stats-value">${dirsN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">${tr("statsPop.tags")}</span><span class="stats-value">${tags.length}</span></div>`;
            html += '</div>';

            if (exts.length > 0) {
                html += `<div class="stats-section-title">${tr("statsPop.exts")}</div>`;
                html += '<div class="stats-grid">';
                for (const [ext, n] of exts) {
                    html += `<div class="stats-ext"><span class="ext-name">.${esc(ext)}</span><span class="ext-count">${n}</span></div>`;
                }
                html += '</div>';
            }
            return html;
        }

        function patchStatsButton(p, tags) {
            const popup = document.getElementById('hdr-stats-popup');
            const countEl = document.getElementById('hdr-stats-count');
            if (!popup) return;
            if (countEl) countEl.textContent = p.totalFiles || 0;

            // Skeleton (tab bar + panes) is built once per project; refresh
            // cycles rewrite only the numbers pane so an open trends tab (and
            // its fetched chart) survives live patches.
            if (popup.dataset.project !== p.name) {
                popup.dataset.project = p.name;
                const tabStyle = "cursor:pointer;padding:0 2px 5px;font-size:0.85em;border-bottom:2px solid transparent";
                popup.innerHTML = `
                    <div style="display:flex;gap:12px;margin-bottom:8px;border-bottom:1px solid var(--border)">
                        <span data-stats-tab="numbers" style="${tabStyle}">${tr("statsPop.title")}</span>
                        <span data-stats-tab="trends" style="${tabStyle}">${tr("statsPop.tabTrends")}</span>
                    </div>
                    <div data-stats-pane="numbers"></div>
                    <div data-stats-pane="trends" style="display:none"></div>`;
                popup.onclick = (e) => {
                    const t = e.target.closest('[data-stats-tab]');
                    if (!t) return;
                    setStatsTab(popup, t.dataset.statsTab);
                    if (t.dataset.statsTab === 'trends') loadTrendsPane(popup, p.name);
                };
                setStatsTab(popup, 'numbers');
            }

            const numPane = popup.querySelector('[data-stats-pane="numbers"]');
            const html = statsNumbersHtml(p, tags);
            if (numPane && numPane.dataset.hash !== html) {
                numPane.dataset.hash = html;
                numPane.innerHTML = html;
            }

            const btn = document.getElementById('hdr-stats');
            if (btn) {
                btn.title = tr("statsPop.open");
                btn.onclick = (e) => {
                    if (e.target.closest('.stats-popup')) return;
                    window.open(`/stack-map.html?project=${encodeURIComponent(p.name)}`, '_blank');
                };
            }
        }

        export const vulnCache = {}; // { projectName: { libName: vulnResult } }

        // Public registry page for a package, derived from the project language
        // (same ecosystem map the server scans against). Lets the user click a
        // library to verify the version/date manually. Returns '' for
        // ecosystems with no stable per-package page (C/C++/vcpkg).
        export function registryUrl(language, name) {
            if (!name) return '';
            const n = encodeURIComponent(name);
            switch (language) {
                // npm names are URL-path-safe by spec; keep the @ and / raw so
                // scoped packages (@scope/name) resolve to their canonical page.
                case 'TypeScript':
                case 'JavaScript': return `https://www.npmjs.com/package/${name}`;
                case 'Python': return `https://pypi.org/project/${n}/`;
                case 'Rust': return `https://crates.io/crates/${n}`;
                case 'Go': return `https://pkg.go.dev/${name}`; // import path — keep slashes
                case 'PHP': return `https://packagist.org/packages/${n}`;
                case 'C#': return `https://www.nuget.org/packages/${n}`;
                case 'Ruby': return `https://rubygems.org/gems/${n}`;
                case 'Java': return `https://central.sonatype.com/search?q=${n}`;
                default: return '';
            }
        }

        // #777: the old inline `#hdr-libraries` badge strip died when the header
        // template dropped that element — the deps button/popup is the libraries
        // surface now, so this just feeds it.
        export function patchLibraries(p) {
            // Use saved vulnResults from server if no fresh scan in cache
            patchDepsButton(p, vulnCache[p.name] || p.vulnResults || {});
        }

        function patchDepsButton(p, vulns) {
            const btn = document.getElementById('hdr-deps');
            const popup = document.getElementById('hdr-deps-popup');
            const countEl = document.getElementById('hdr-deps-count');
            if (!btn || !popup || !countEl) return;

            const libs = p.libraries || [];
            countEl.textContent = libs.length;

            // Determine overall status
            let status = 'unknown';
            const anyScanned = libs.some(l => { const v = vulns[l.name]; return v && v.status !== "indeterminate"; });
            if (anyScanned) {
                status = 'safe';
                for (const l of libs) {
                    const v = vulns[l.name];
                    if (!v || v.status === "indeterminate") continue;
                    if (v.icon === 'warning' || v.icon === 'x') { status = 'danger'; break; }
                    if (v.isLatest === false && l.version !== 'latest') status = 'warn';
                }
            }
            btn.classList.remove('safe', 'warn', 'danger', 'unknown');
            btn.classList.add(status);

            // Click opens the deps explainer page (purpose lines + official
            // descriptions) — same pattern as stats → stack-map. The hover
            // popup keeps its quick-glance role unchanged. Attached before the
            // zero-libs early return so the button behaves uniformly.
            btn.title = tr("deps.openTitle");
            btn.onclick = (e) => {
                if (e.target.closest('.deps-popup')) return;
                window.open(`/deps.html?project=${encodeURIComponent(p.name)}`, '_blank');
            };
            btn.style.cursor = 'pointer';

            // Sort: danger first, then warn, then safe, then unknown
            const rank = (l) => {
                const v = vulns[l.name];
                if (v && (v.icon === 'warning' || v.icon === 'x')) return 0;
                if (v && v.status !== 'indeterminate' && v.isLatest === false && l.version !== 'latest') return 1;
                if (v && v.status !== 'indeterminate') return 2;
                return 3;
            };
            const sorted = [...libs].sort((a, b) => rank(a) - rank(b));

            if (libs.length === 0) {
                popup.innerHTML = `<div class="deps-empty">${tr("deps.empty")}</div>`;
                return;
            }
            popup.innerHTML = sorted.map(l => {
                const v = vulns[l.name];
                let cls = 'unknown';
                let target = '';
                if (v && v.status !== 'indeterminate') {
                    if (v.icon === 'warning' || v.icon === 'x') {
                        cls = 'danger';
                        target = v.fixVersion || v.latestVersion || '';
                    } else if (v.isLatest === false && l.version !== 'latest') {
                        cls = 'warn';
                        target = v.latestVersion || '';
                    } else {
                        cls = 'safe';
                    }
                }
                const arrow = target ? `<span class="lib-arrow">→</span><span class="lib-ver">${esc(target)}</span>` : '';
                const devTag = l.dev ? '<span class="lib-tag">dev</span>' : '';
                const url = registryUrl(p.language, l.name);
                const nameEl = url
                    ? `<a class="lib-name" href="${esc(url)}" target="_blank" rel="noopener" title="${tr("lib.openPage")}">${esc(l.name)}</a>`
                    : `<span class="lib-name">${esc(l.name)}</span>`;
                // Supply-chain safety net (Vuln API v0.6.0): warn when the fix
                // was published recently — compromised packages have stayed
                // live for hours-to-days before discovery (event-stream, nx).
                const freshFix = cls === 'danger' && v && typeof v.daysSinceFix === 'number' && v.daysSinceFix < 7
                    ? `<span class="lib-fresh" title="${tr("deps.freshTitle", { d: v.daysSinceFix })}">${tr("deps.freshLabel", { d: v.daysSinceFix })}</span>` : '';
                return `<div class="deps-row ${cls}">
                    ${devTag}
                    ${nameEl}
                    <span class="lib-ver">${esc(l.version)}</span>
                    ${arrow}
                    ${freshFix}
                </div>`;
            }).join('');
        }

        export function patchHeader() {
            const p = data.projects[activeProject];
            if (!p || !headerBuilt) return;
            const tags = getProjectTags();

            // Description — patch the text span ONLY. The about button is a sibling
            // inside #hdr-desc; writing to the container's textContent would delete it
            // (the disappear-on-refresh bug). Keep them independent.
            const descWrap = document.getElementById('hdr-desc');
            const descText = document.getElementById('hdr-desc-text');
            if (descWrap && descText) {
                const newDesc = p.description || '';
                if (descText.textContent !== newDesc) {
                    descText.textContent = newDesc;
                    descText.style.display = newDesc ? '' : 'none';
                    if (newDesc) { descText.classList.remove('val-flash'); void descText.offsetWidth; descText.classList.add('val-flash'); }
                }
                // Refresh the about button's state live (e.g. an -(about) was just added)
                // without rebuilding it, so it never blinks out between patches.
                const hasAbout = !!(p.about?.trim());
                const aboutBtn = document.getElementById('hdr-about-btn');
                if (aboutBtn) {
                    const ab = aboutBtnAttrs(hasAbout);
                    if (aboutBtn.className !== ab.cls) aboutBtn.className = ab.cls;
                    aboutBtn.title = ab.title;
                }
                descWrap.style.display = (newDesc || hasAbout) ? '' : 'none';
            }

            // Version
            const lastRelease = tags.find(t => t.tag === "release");
            const versionMatch = lastRelease?.content.match(/v[\d.]+/);
            const vEl = document.getElementById('hdr-version');
            if (vEl) {
                if (versionMatch) { patch(vEl, versionMatch[0]); vEl.style.display = ''; }
                else { vEl.style.display = 'none'; }
            }

            // Language
            const langEl = document.getElementById('hdr-lang');
            if (langEl && langEl.textContent !== p.language) {
                const color = langColors[p.language] || langColors.default;
                langEl.textContent = p.language;
                langEl.style.background = `${color}18`;
                langEl.style.color = color;
                langEl.classList.remove('val-flash'); void langEl.offsetWidth; langEl.classList.add('val-flash');
            }

            // Framework — the span always exists (display:none when absent), so a
            // framework detected by a later rescan appears without a reload.
            const fwEl = document.getElementById('hdr-framework');
            if (fwEl) {
                patch(fwEl, p.framework || '');
                fwEl.style.display = p.framework ? '' : 'none';
            }

            // Git badge (#492) — built as <a> or <span> depending on the remote, so
            // a live change swaps the element wholesale instead of patching text.
            const gitEl = document.getElementById('hdr-git');
            if (gitEl && gitEl.dataset.remote !== (p.gitRemote || '')) {
                gitEl.outerHTML = gitBadgeHtml(p);
            }

            // Runtime — same always-present pattern as the framework badge.
            const rtEl = document.getElementById('hdr-runtime');
            if (rtEl) {
                const rtText = p.runtime ? (p.runtime.name || '') + (p.runtime.version ? ` ${p.runtime.version}` : '') + (p.runtime.edition ? ` · ${p.runtime.edition}` : '') : '';
                patch(rtEl, rtText);
                rtEl.style.display = rtText ? '' : 'none';
            }

            // Libraries
            patchLibraries(p);

            // Active Claude sessions + background processes
            patchSessions(p.name);

            // Stats popup (files, libs, dirs, tags, exts)
            patchStatsButton(p, tags);
        }

