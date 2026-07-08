        import { data, activeProject, cachedTree, setCachedTree, setLogFilterValue, fullRenderNeeded, setFullRenderNeeded, ctxTargetPath, ctxTargetFile, setCtxTarget } from "./dashboard-state.js";
        import { API, esc, timeStr, openedTitle, SEC_OPEN_TAGS, TOOL_FG_COLORS, uiAlert } from "./dashboard-core.js";
        import { fetchSummary, refreshActiveView, currentVerdicts, buildTagsHtml } from "./dashboard-data.js";
        import { getProjectTags, projectFromHash, selectProject, registryUrl } from "./dashboard-project.js";
        import { extIcons, renderActivePlanCard, renderChangesCard, buildTodosHtml } from "./dashboard-panels.js";

        function renderTreeNodes(nodes, basePath) {
            let html = '';
            for (const node of nodes) {
                if (node.type === "dir") {
                    const count = countFiles(node);
                    const fullPath = `${basePath}/${node.name}`;
                    html += `<div class="tree-node">
                        <div class="tree-dir" data-path="${esc(fullPath)}">
                            <span class="arrow">&#9660;</span>
                            <span>${esc(node.name)}</span>
                            <span class="tree-count">${count}</span>
                        </div>
                        <div class="tree-children">${node.children ? renderTreeNodes(node.children, fullPath) : ''}</div>
                    </div>`;
                } else {
                    const color = extIcons[node.ext] || "var(--text2)";
                    const dot = `<span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>`;
                    html += `<div class="tree-file" data-dir="${esc(basePath)}" data-name="${esc(node.name)}">${dot}<span class="tree-fname">${esc(node.name)}</span></div>`;
                }
            }
            return html;
        }

        // Context menu
        document.addEventListener('click', () => {
            document.getElementById('ctxMenu').style.display = 'none';
            document.querySelectorAll('.ctx-selected').forEach(el => { el.classList.remove('ctx-selected'); });
        });
        document.addEventListener('contextmenu', (e) => {
            const tree = e.target.closest('.tree');
            if (!tree) return;

            const dir = e.target.closest('.tree-dir');
            const file = e.target.closest('.tree-file');

            if (dir) {
                e.preventDefault();
                setCtxTarget(dir.getAttribute('data-path') || '', '');
                document.getElementById('ctxIgnoreLabel').textContent = 'تجاهل هذا المجلد';
                document.getElementById('ctxOpenLabel').style.display = 'none';
            } else if (file) {
                e.preventDefault();
                setCtxTarget(file.getAttribute('data-dir') || '', file.getAttribute('data-name') || '');
                document.getElementById('ctxIgnoreLabel').textContent = 'تجاهل هذا الملف';
                document.getElementById('ctxOpenLabel').style.display = 'block';
            } else {
                return;
            }

            // Opening the menu: hide the hover popup so the two floating layers
            // don't overlap, and highlight the target so the user can see exactly
            // which file/dir the menu acts on.
            clearTimeout(filePopupTimer);
            clearTimeout(filePopupHideTimer);
            if (filePopupController) filePopupController.abort();
            const fp = document.getElementById('filePopup');
            if (fp) fp.style.display = 'none';
            document.querySelectorAll('.ctx-selected').forEach(el => { el.classList.remove('ctx-selected'); });
            (dir || file).classList.add('ctx-selected');

            const menu = document.getElementById('ctxMenu');
            menu.style.display = 'block';
            menu.style.left = `${e.clientX}px`;
            menu.style.top = `${e.clientY}px`;
        });

        export async function ignoreTarget() {
            document.getElementById('ctxMenu').style.display = 'none';
            const winPath = ctxTargetPath.replace(/\//g, '\\');
            const body = ctxTargetFile
                ? { path: winPath, file: ctxTargetFile }
                : { path: winPath };
            try {
                const res = await fetch(`${API}/api/ignore`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const result = await res.json();
                if (result.ignored) {
                    // Remove element from DOM directly for instant feedback
                    if (ctxTargetFile) {
                        document.querySelectorAll('.tree-file').forEach(el => {
                            if (el.getAttribute('data-name') === ctxTargetFile && el.getAttribute('data-dir') === ctxTargetPath) {
                                el.style.transition = 'opacity 0.2s';
                                el.style.opacity = '0';
                                setTimeout(() => el.remove(), 200);
                            }
                        });
                    } else {
                        document.querySelectorAll('.tree-dir').forEach(el => {
                            if (el.getAttribute('data-path') === ctxTargetPath) {
                                const node = el.closest('.tree-node');
                                if (node) {
                                    node.style.transition = 'opacity 0.2s';
                                    node.style.opacity = '0';
                                    setTimeout(() => node.remove(), 200);
                                }
                            }
                        });
                    }
                }
                // Refresh data + header to reflect updated file stats
                setFullRenderNeeded(true);
                setCachedTree(null);
                refreshActiveView(true);
            } catch {
                // Best-effort: the tree stays stale until the next WS pulse.
            }
        }

        // Open the right-clicked file's content in a new browser tab. The server
        // serves it as text/plain + nosniff, so even .html/.svg files just show
        // as text and never execute.
        export function openTargetFile() {
            document.getElementById('ctxMenu').style.display = 'none';
            if (!ctxTargetFile) return;
            const full = `${ctxTargetPath.replace(/\\/g, '/')}/${ctxTargetFile}`;
            window.open(`${API}/api/file?path=${encodeURIComponent(full)}`, '_blank');
        }

        // ===== File hover preview popup =====
        let filePopupTimer = null;
        let filePopupHideTimer = null;
        let filePopupController = null;
        let lastMouse = { x: 0, y: 0 };
        document.addEventListener('mousemove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; });
        document.addEventListener('mouseover', (e) => {
            const file = e.target.closest?.('.tree-file');
            if (!file) return;
            clearTimeout(filePopupHideTimer);
            clearTimeout(filePopupTimer);
            filePopupTimer = setTimeout(() => showFilePopup(file), 280);
        });
        document.addEventListener('mouseout', (e) => {
            const file = e.target.closest?.('.tree-file');
            if (!file) return;
            clearTimeout(filePopupTimer);
            // Delayed hide: gives the cursor time to travel into the popup so the
            // user can scroll it. Entering the popup cancels this (see binding below).
            scheduleHideFilePopup();
        });
        function scheduleHideFilePopup() {
            clearTimeout(filePopupHideTimer);
            filePopupHideTimer = setTimeout(hideFilePopup, 250);
        }
        function hideFilePopup() {
            clearTimeout(filePopupTimer);
            if (filePopupController) filePopupController.abort();
            const popup = document.getElementById('filePopup');
            if (popup) popup.style.display = 'none';
        }

        async function showFilePopup(file) {
            const dir = (file.getAttribute('data-dir') || '').replace(/\\/g, '/');
            const name = file.getAttribute('data-name') || '';
            if (!dir || !name) return;
            const popup = document.getElementById('filePopup');
            if (!popup) return;
            // Keep the popup open while the cursor is inside it (so it can be
            // scrolled), and close it once the cursor leaves. Bound once.
            if (!popup.dataset.bound) {
                popup.dataset.bound = '1';
                popup.addEventListener('mouseenter', () => clearTimeout(filePopupHideTimer));
                popup.addEventListener('mouseleave', hideFilePopup);
            }
            // Don't pop up while the right-click menu is open — keeps the two
            // floating layers from covering each other.
            const menu = document.getElementById('ctxMenu');
            if (menu && menu.style.display === 'block') return;
            if (filePopupController) filePopupController.abort();
            filePopupController = new AbortController();
            try {
                const r = await fetch(`${API}/api/file?path=${encodeURIComponent(`${dir}/${name}`)}`, { signal: filePopupController.signal });
                if (!r.ok) return;
                popup.textContent = await r.text();   // textContent → no HTML injection
                popup.style.display = 'block';
                positionFilePopup(popup);
            } catch (_) { /* aborted or fetch failed */ }
        }

        function positionFilePopup(popup) {
            const pad = 14;
            const rect = popup.getBoundingClientRect();
            let x = lastMouse.x + 16, y = lastMouse.y + 16;
            if (x + rect.width + pad > window.innerWidth) x = lastMouse.x - rect.width - 16;
            if (y + rect.height + pad > window.innerHeight) y = window.innerHeight - rect.height - pad;
            popup.style.left = `${Math.max(pad, x)}px`;
            popup.style.top = `${Math.max(pad, y)}px`;
        }

        function countFiles(node) {
            if (node.type === "file") return 1;
            let c = 0;
            if (node.children) for (const child of node.children) c += countFiles(child);
            return c;
        }

        // ===== Tab 2: Architecture =====

        // ===== Main View =====

        // cachedTree moved to dashboard-state.js (R3 #3) — data/project reset it too.

        export async function renderFiles(project, tags) {
            const el = document.getElementById("panel-files");

            // Build tags HTML (only tags)
            // Build events HTML (raw hooks)
            // Build todos + security HTML — shared builders, identical to the
            // surgical poll/WS path so neither card can diverge on refresh.
            const todosCardHtml = buildTodosHtml(tags);
            const secHtml = buildSecurityHtml(tags, project);

            // Build the card layout once, BEFORE any await. The file tree used
            // to be fetched at the top of this block and a slow/failed
            // /api/tree request on a refresh threw before the layout existed —
            // the catch then wiped the whole panel, blanking every card even
            // though only the tree was unavailable. Layout + data-driven cards
            // must never depend on the tree fetch.
            if (!document.getElementById('cardTree')) {
                el.innerHTML = `<div style="display:flex;gap:8px;height:100%;direction:ltr">
                    <div id="cardTree" style="flex:1;min-width:0;background:var(--bg3);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column"></div>
                    <div style="flex:1;min-width:0;min-height:0;display:grid;grid-template-rows:1fr 1fr;gap:8px">
                        <div id="cardDocs" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-height:0;display:flex;flex-direction:column;direction:rtl;overflow:hidden"></div>
                        <div id="eventsCard" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-height:0;display:flex;flex-direction:column;direction:ltr;overflow:hidden"></div>
                    </div>
                    <div style="flex:1;min-width:0;min-height:0;display:grid;grid-template-rows:1fr 1fr;gap:8px">
                        <div id="cardSecurity" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-height:0;display:flex;flex-direction:column;direction:rtl;overflow:hidden"></div>
                        <div id="cardTodos" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-height:0;display:flex;flex-direction:column;direction:rtl;overflow:hidden"></div>
                    </div>
                    <div style="flex:2;min-width:0;min-height:0;display:grid;grid-template-rows:1fr 1fr;gap:8px">
                        <div id="cardTags" style="background:var(--bg3);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;direction:rtl;min-height:0;overflow:hidden"></div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;min-height:0">
                            <div id="cardActivePlan" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-width:0;min-height:0;display:flex;flex-direction:column;direction:rtl;overflow:hidden"></div>
                            <div id="cardChanges" style="background:var(--bg3);border-radius:8px;padding:10px 12px;min-width:0;min-height:0;display:flex;flex-direction:column;direction:rtl;overflow:hidden"></div>
                        </div>
                    </div>
                </div>`;
            }

            // Fill the data-driven cards (independent of the file tree) so they
            // always render even when the tree request is in flight or fails.
            document.getElementById('cardSecurity').innerHTML = `<div style="overflow-y:auto;flex:1;min-height:0">${secHtml}</div>`;
            document.getElementById('cardTodos').innerHTML = todosCardHtml;
            document.getElementById('cardTags').innerHTML = buildTagsHtml(tags);
            renderChangesCard(activeProject);
            renderActivePlanCard(activeProject);
            // `project` here is the project OBJECT (renderFiles(p, …)); buildEventsHtml
            // filters by NAME (e.project === name), so passing the object matched
            // nothing and the events card rendered empty on every full render —
            // events only appeared via the surgical WS path (which passes the name)
            // and vanished on project switch. Use activeProject (the name string).
            document.getElementById('eventsCard').innerHTML = buildEventsHtml(data.events, activeProject);
            document.getElementById('cardDocs').innerHTML = buildDocsHtml(project);

            // Fetch + render the file tree on its own. A tree error now only
            // touches the tree card — the rest of the project view stays put.
            try {
                if (!cachedTree || fullRenderNeeded) {
                    const res = await fetch(`${API}/api/tree/${encodeURIComponent(activeProject)}`);
                    const { tree } = await res.json();
                    setCachedTree(tree);
                }
                const tree = cachedTree;
                const total = tree ? countFiles({ type: "dir", children: tree }) : 0;
                const treeCard = document.getElementById('cardTree');
                if (treeCard) {
                    treeCard.innerHTML = `
                        <div style="font-size:0.6em;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">الملفات <span style="opacity:0.6">${total}</span></div>
                        <div style="overflow-y:auto;flex:1;min-height:0"><div class="tree">${tree && tree.length > 0 ? renderTreeNodes(tree, (project.path || '').replace(/\\/g, '/')) : '<span style="color:var(--text2);font-size:0.75em">لا توجد ملفات</span>'}</div></div>`;
                    treeCard.querySelectorAll('.tree-dir').forEach(dir => {
                        dir.addEventListener('click', () => {
                            dir.classList.toggle('collapsed');
                            const children = dir.nextElementSibling;
                            if (children) children.classList.toggle('hidden');
                        });
                    });
                }
            } catch {
                const treeCard = document.getElementById('cardTree');
                if (treeCard) treeCard.innerHTML = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">الملفات</div><div style="color:var(--text2);font-size:0.75em">تعذّر تحميل شجرة الملفات</div>`;
            }
        }

        const typeLabels = { user: 'مستخدم', feedback: 'ملاحظة', project: 'مشروع', reference: 'مرجع' };
        const typeColors = { user: 'var(--blue)', feedback: 'var(--gold)', project: 'var(--emerald)', reference: '#bb86fc' };

        export function buildDocsHtml(project) {
            const mem = project.memoryFiles || [];
            const docs = project.docFiles || [];
            const total = mem.length + docs.length;

            let h = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">الذاكرة والتوثيق <span style="opacity:0.6">${total}</span></div>`;
            h += '<div style="overflow-y:auto;flex:1;min-height:0">';

            if (mem.length > 0) {
                h += `<div style="font-size:0.7em;color:var(--text2);margin-bottom:4px">ذاكرة</div>`;
                mem.forEach((m, i) => {
                    const color = typeColors[m.type] || 'var(--text2)';
                    h += `<div class="mem-row" data-mem-kind="mem" data-mem-idx="${i}" style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.7em">
                        <span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0"></span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name)}</span>
                        <span style="font-size:0.8em;color:${color};flex-shrink:0">${esc(typeLabels[m.type] || m.type)}</span>
                    </div>`;
                });
            }

            if (docs.length > 0) {
                h += `<div style="font-size:0.7em;color:var(--text2);margin:${mem.length ? '8px' : '0'} 0 4px">توثيق</div>`;
                docs.forEach((d, i) => {
                    h += `<div class="mem-row" data-mem-kind="docs" data-mem-idx="${i}" style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.7em">
                        <span style="width:6px;height:6px;border-radius:50%;background:var(--gold);flex-shrink:0"></span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name || d.file)}</span>
                    </div>`;
                });
            }

            if (total === 0) {
                h += '<div style="color:var(--text2);font-size:0.7em">لا توجد ملفات</div>';
            }

            h += '</div>';
            return h;
        }

        // Single source for the المهام card so the full render and the surgical
        // poll/WS update can never diverge (the bug where #N badges + notes
        // vanished on refresh until you re-clicked the project — the surgical
        // path used to rebuild this card without them). Mirrors buildSecurityHtml.
        // Shared events-card builder (#229) — used by BOTH the full render and
        // the surgical updateCards/WS path so the card can't drift between them.
        // The two inline copies had already diverged (item-new highlight on the
        // surgical path, absent on the full render). Returns the complete card
        // (header + scroll container + rows), exactly like buildTodosHtml.
        export function buildEventsHtml(allEvents, project) {
            const projEvents = (allEvents || []).filter(e => e.project === project).slice(-50).reverse();
            let inner = '';
            for (const e of projEvents) {
                const color = TOOL_FG_COLORS[e.tool] || 'var(--text2)';
                const fname = e.file_path ? e.file_path.replace(/\\/g,'/').split('/').pop() : '';
                const desc = fname || e.command?.slice(0,30) || e.description?.slice(0,30) || e.event;
                inner += `<div class="item-new" style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em">
                    <span style="color:${color};font-weight:600;min-width:28px">${esc(e.tool || e.event)}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace">${esc(desc)}</span>
                    <span style="color:var(--border);flex-shrink:0">${timeStr(e.timestamp)}</span>
                </div>`;
            }
            return `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;direction:rtl">الأحداث</div><div style="overflow-y:auto;flex:1;min-height:0">${inner || '<div style="color:var(--text2);font-size:0.7em;direction:rtl">لا توجد أحداث</div>'}</div>`;
        }

        // buildTodosHtml + the الحالية/القادمة cardTabs live in dashboard-panels.js
        // (moved with the upcoming feature — this file sits at its size budget).

        export function buildSecurityHtml(tags, project) {
            // Pull vuln dates by package name (parsed from tag content like
            // "sysinfo@0.38.4 — احدث: 0.39.1"). Used to show release dates +
            // the "wait before upgrading" supply-chain warning (Vuln v0.6.0).
            const vulnResults = (project?.vulnResults) || {};
            const parsePkg = (content) => {
                // Optional leading @ + the rest of the name (slashes allowed) so
                // scoped npm packages like "@biomejs/biome@2.4.15" parse — the
                // old /^[^\s@]+@/ choked on the leading @ and left them with no
                // link and no release-date caption.
                const m = String(content).match(/^(@?[^\s@]+)@([^\s—]+)/);
                return m ? { name: m[1], version: m[2], info: vulnResults[m[1]] || null } : null;
            };
            // Two-line library row used by both "ثغرات مُصلحة" (kind=fix) and
            // "مكتبات قديمة" (kind=latest). Top line is LTR (English versions);
            // bottom caption is RTL Arabic so the date isn't mistaken for a
            // discovery date — the label makes intent explicit.
            const libRow = (content, kind, opts) => {
                const accent = opts.accent;          // CSS var, e.g. var(--gold)
                const iconChar = opts.icon;          // ↻ / ✓
                const strike = opts.strike || false; // line-through current ver
                const opacity = opts.opacity || 1;
                const parsed = parsePkg(content);
                if (!parsed) {
                    return `<div dir="ltr" style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.72em;opacity:${opacity}">
                        <span style="color:${accent};flex-shrink:0">${iconChar}</span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${accent}">${esc(content)}</span>
                    </div>`;
                }
                const v = parsed.info;
                const target = v ? (kind === 'fix' ? (v.fixVersion || v.latestVersion) : v.latestVersion) : '';
                const dateStr = v ? (kind === 'fix' ? v.fixReleaseDate : v.latestReleaseDate) : '';
                const days = v ? (kind === 'fix' ? v.daysSinceFix : v.daysSinceLatest) : null;
                const isFresh = kind === 'latest' && typeof days === 'number' && days < 7;
                const dateLabel = kind === 'fix' ? 'صدر الفيكس' : 'صدر الإصدار الجديد';
                const datePart = dateStr ? new Date(dateStr).toISOString().slice(0, 10) : '';
                const caption = (typeof days === 'number' || datePart)
                    ? `<div dir="rtl" style="margin-right:22px;color:${isFresh ? 'var(--gold)' : 'var(--text2)'};font-size:0.85em;padding-top:1px">
                          ${isFresh ? '⏳ ' : ''}${esc(dateLabel)}${typeof days === 'number' ? ` منذ ${days} يوم` : ''}${datePart ? ` · ${esc(datePart)}` : ''}
                       </div>` : '';
                const verStyle = strike ? 'text-decoration:line-through;color:var(--text2)' : `color:${accent}`;
                const url = registryUrl(project?.language, parsed.name);
                const nameEl = url
                    ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="فتح صفحة المكتبة للتأكد يدوياً" style="color:${accent};font-weight:600;text-decoration:none;cursor:pointer">${esc(parsed.name)}</a>`
                    : `<span style="color:${accent};font-weight:600">${esc(parsed.name)}</span>`;
                return `<div style="padding:5px 0;font-size:0.72em;opacity:${opacity}">
                    <div dir="ltr" style="display:flex;align-items:center;gap:6px;white-space:nowrap;overflow:hidden">
                        <span style="color:${accent};flex-shrink:0">${iconChar}</span>
                        ${nameEl}
                        <span style="${verStyle}">${esc(parsed.version)}</span>
                        ${target ? `<span style="color:var(--text2)">→</span><span style="color:${accent}">${esc(target)}</span>` : ''}
                    </div>
                    ${caption}
                </div>`;
            };
            const securityTags = tags.filter(t => SEC_OPEN_TAGS.has(t.tag));
            const bugFounds = tags.filter(t => t.tag === "bug found");
            const outdatedTags = tags.filter(t => t.tag === "outdated");

            // Open/fixed split comes from the server verdicts by tag id (#379);
            // a missing verdict (transient fetch race) defaults to "open" — the
            // safe direction for security items. currentVerdicts serves the last
            // good snapshot through a transient failure instead of an all-open flash (#414).
            const { v } = currentVerdicts();
            const openById = new Map();
            const upcomingIds = new Set();
            if (v) {
                for (const x of v.security) openById.set(x.id, x.open);
                for (const x of v.bugs) { openById.set(x.id, x.open); if (x.upcoming) upcomingIds.add(x.id); }
            }
            const secClosed = s => openById.get(s.id) === false;
            const bugClosed = b => openById.get(b.id) === false;
            // Deferred («قادمة») bugs render in the tasks card's القادمة tab, not
            // here — an item the user parked must not read as pressing red debt.
            const isUpcoming = b => (v ? upcomingIds.has(b.id) : !!b.upcoming);
            const openSec = securityTags.filter(s => !secClosed(s));
            const closedSec = securityTags.filter(secClosed);
            const openBugs = bugFounds.filter(b => !bugClosed(b) && !isUpcoming(b));
            const closedBugs = bugFounds.filter(bugClosed);

            // Totals derive from the rendered lists so a deferred bug (excluded
            // above) can't skew the counts or the progress bar.
            const totalFixed = closedSec.length + closedBugs.length;
            const totalOpen = openSec.length + openBugs.length;
            const totalIssues = totalFixed + totalOpen;

            if (totalIssues === 0 && outdatedTags.length === 0) {
                return '<div style="color:var(--text2);font-size:0.75em;padding:10px;text-align:center">لا توجد مشاكل أمنية</div>';
            }

            const pct = totalIssues > 0 ? Math.round((totalFixed / totalIssues) * 100) : 0;
            let h = '';

            h += `<div style="display:flex;gap:10px;margin-bottom:10px">
                <div style="text-align:center;flex:1"><span style="font-size:1.2em;font-weight:700;color:${totalOpen > 0 ? 'var(--pink)' : 'var(--emerald)'}">${totalOpen}</span><div style="font-size:0.6em;color:var(--text2)">مفتوحة</div></div>
                <div style="text-align:center;flex:1"><span style="font-size:1.2em;font-weight:700;color:var(--emerald)">${totalFixed}</span><div style="font-size:0.6em;color:var(--text2)">مُصلحة</div></div>
                <div style="text-align:center;flex:1"><span style="font-size:1.2em;font-weight:700;color:var(--gold)">${outdatedTags.length}</span><div style="font-size:0.6em;color:var(--text2)">قديمة</div></div>
            </div>`;

            h += `<div class="progress-row" style="margin-bottom:12px">
                <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:var(--emerald)"></div></div>
                <span class="progress-pct">${pct}%</span>
            </div>`;

            const numCode = (n) => typeof n === "number"
                ? `<span style="font-size:0.85em;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;flex-shrink:0">#${n}</span>`
                : '';
            const delBtn = (id, kind) => `<button data-action="delete-tag" data-tag-id="${esc(id)}" data-tag-kind="${kind}" title="حذف نهائي (لـfalse positive أو إدخال خاطئ)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:1em;padding:0 4px;flex-shrink:0;line-height:1">×</button>`;
            if (openSec.length > 0) {
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px">ثغرات مفتوحة</div>';
                for (const s of openSec) {
                    // The content is clickable → opens the per-CVE modal for this
                    // library (parses the lib name out of the "name@ver — …" headline).
                    const clickable = s.tag === 'security';
                    const sattr = clickable
                        ? ` data-action="show-vulns-tag" data-project="${esc(activeProject)}" data-content="${esc(s.content)}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pink);cursor:pointer;text-decoration:underline dotted"`
                        : ` style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pink)"`;
                    const stitle = [clickable ? `${s.content} — اضغط لتفاصيل الثغرات` : s.content, openedTitle(s.timestamp)].filter(Boolean).join('\n');
                    h += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.72em">
                        <span style="color:var(--pink)">!</span>
                        ${numCode(s.num)}
                        <span${sattr} title="${esc(stitle)}">${esc(s.content)}</span>
                        ${delBtn(s.id, 'security')}
                    </div>`;
                }
            }
            if (openBugs.length > 0) {
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px">أخطاء مفتوحة</div>';
                for (const b of openBugs) {
                    h += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.72em">
                        <span style="color:var(--pink)">!</span>
                        ${numCode(b.num)}
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pink)" title="${esc([b.content, openedTitle(b.timestamp)].filter(Boolean).join('\n'))}">${esc(b.content)}</span>
                        ${delBtn(b.id, 'bug')}
                    </div>`;
                }
            }
            // Order rule (user directive 2026-07-06): everything OPEN/actionable
            // first — open security, open bugs, then the outdated libraries —
            // and the CLOSED (historic) lists always sit at the bottom.
            if (outdatedTags.length > 0) {
                // Supply-chain safety: when latest is very fresh (< 7 days),
                // libRow renders the gold ⏳ warning. Recent npm/crates
                // compromises (event-stream, nx, ua-parser-js) stayed live
                // for hours-to-days before discovery — rapid auto-upgrades
                // were the attack vector.
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px">مكتبات قديمة</div>';
                for (const o of outdatedTags) {
                    h += libRow(o.content, 'latest', { accent: 'var(--gold)', icon: '&#8635;' });
                }
            }
            if (closedSec.length > 0) {
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px">ثغرات مُصلحة</div>';
                for (const s of closedSec) {
                    h += libRow(s.content, 'fix', { accent: 'var(--emerald)', icon: '&#10003;', strike: true, opacity: 0.6 });
                }
            }
            if (closedBugs.length > 0) {
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px">أخطاء مُصلحة</div>';
                for (const b of closedBugs) {
                    h += `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.72em;opacity:0.6">
                        <span style="color:var(--emerald)">&#10003;</span>
                        <span style="flex:1;text-decoration:line-through;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.content)}</span>
                    </div>`;
                }
            }
            return h;
        }

        // ===== Filters =====



        export function setLogFilter(filter) {
            setLogFilterValue(filter);
            const p = data.projects[activeProject];
            if (p) renderFiles(p, getProjectTags());
        }

        // ===== Tab 5: Project =====

        // ===== Injection Panel =====

        const injState = {
            project: null,
            scope: "global", // "global" | "project"
            config: null,    // { sessionStart, userPromptSubmit, ... }
            hasOverride: false,
            history: [],
        };

        const injTypeMeta = {
            sessionStart:     { label: "SessionStart",     sub: "حقن ملخص المشروع عند بدء الجلسة",              dynamic: true },
            userPromptSubmit: { label: "UserPromptSubmit", sub: "تذكير تلقائي بالمهام المتبقية لكلود كود",         dynamic: true },
            preToolUseRead:   { label: "PreToolUse(Read)", sub: "حقن ذاكرة الملف قبل قراءته",                   dynamic: true },
            outdatedLibs:     { label: "مكتبات منتهية",     sub: "تنبيه كلود بكل المكتبات القديمة عند بدء الجلسة", dynamic: true },
            describeNudge:    { label: "تذكير الوصف",       sub: "تنبيه كلود لإضافة desc/about الناقصَين. يعمل حتى مع إطفاء «حقن البداية»", dynamic: true },
            upcomingItems:    { label: "سطر القادمة",       sub: "عرض العناصر المؤجلة (قادمة) في ملخص بداية الجلسة — للعلم فقط، لا توقف شيئًا", dynamic: true },
            claudeMd:         { label: "CLAUDE.md",        sub: "كتابة ملخص المشروع في ملف CLAUDE.md (قيد التطوير)", dynamic: false },
            contextMd:        { label: ".devlog/context.md", sub: "كتابة سياق إضافي في ملف (قيد التطوير)",       dynamic: false },
            standardsEnforce: { label: "إجبار المعايير",   sub: "يمنع كتابة الكود حتى يسحب كلود معايير المشروع. أوقفه للمشاريع المطبَّقة أصلاً (السحب اليدوي يبقى متاحاً)." },
        };

        export async function openInjectionPanel(project) {
            injState.project = project;
            injState.scope = "global";
            document.getElementById('injProjectName').textContent = project;
            document.getElementById('injModal').classList.add('open');
            await loadInjectionConfig();
            await loadInjectionHistory();
            renderInjectionPanel();
        }

        export function closeInjectionPanel() {
            document.getElementById('injModal').classList.remove('open');
        }

        // ===== Standards Viewer (read-only catalog browser) =====
        const STD_AXIS_ORDER = ["languages", "runtimes", "frameworks", "platforms", "app-types", "cross-cutting", "(root)"];

        export async function openStandardsPanel(project) {
            document.getElementById('stdProjectName').textContent = project || '';
            document.getElementById('stdModal').classList.add('open');
            const body = document.getElementById('stdBody');
            body.innerHTML = '<div class="inj-empty">جارٍ التحميل…</div>';
            const cwd = (data.projects?.[project]?.path) || '';
            try {
                const res = await fetch(`${API}/api/standards?cwd=${encodeURIComponent(cwd)}`);
                body.innerHTML = renderStandards(await res.json());
            } catch {
                body.innerHTML = '<div class="inj-empty">فشل تحميل المعايير</div>';
            }
        }

        export function closeStandardsPanel() {
            document.getElementById('stdModal').classList.remove('open');
        }

        function renderStandards(j) {
            const cats = j.categories || [];
            if (!cats.length) return '<div class="inj-empty">الكتالوج فارغ — أضف ملفات .md في ~/.claude/standards/</div>';
            const c = j.counts || {};
            const byAxis = {};
            for (const cat of cats) {
                if (!byAxis[cat.axis]) byAxis[cat.axis] = [];
                byAxis[cat.axis].push(cat);
            }
            const axes = Object.keys(byAxis).sort((a, b) => {
                const ia = STD_AXIS_ORDER.indexOf(a), ib = STD_AXIS_ORDER.indexOf(b);
                return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
            });
            const kindBadge = (k) => k === 'check'
                ? '<span class="std-kind std-check">فحص</span>'
                : '<span class="std-kind std-guide">نصيحة</span>';
            let html = `<div class="std-summary">${c.categories || 0} تصنيف · ${c.rules || 0} قاعدة · ${c.enforced || 0} فاحص يحجب</div>`;
            for (const ax of axes) {
                html += `<div class="std-axis">${esc(ax)}</div>`;
                for (const cat of byAxis[ax]) {
                    const scope = cat.scope === 'project' ? '<span class="std-scope">خاص بالمشروع</span>' : '<span class="std-scope std-global">عام</span>';
                    const enforced = cat.enforcedBy ? `<span class="std-enforced" title="يحجب فعلاً">🛡 ${esc(cat.enforcedBy)}</span>` : '';
                    html += `<div class="std-cat"><div class="std-cat-head"><span class="std-cat-name">${esc(cat.category)}</span>${scope}${enforced}</div>`;
                    if (cat.rules?.length) {
                        html += '<div class="std-rules">';
                        for (const r of cat.rules) html += `<div class="std-rule">${kindBadge(r.kind)}<span>${esc(r.text)}</span></div>`;
                        html += '</div>';
                    } else if (cat.rich) {
                        html += '<div class="std-rules std-norules">📄 معيار مرجعي موسّع — افتح الملف لعرض تفاصيله</div>';
                    } else {
                        html += '<div class="std-rules std-norules">لا قواعد بعد</div>';
                    }
                    html += '</div>';
                }
            }
            const acks = j.acks || [];
            if (acks.length) {
                html += `<div class="std-axis">مؤكَّدات هذا المشروع (ack)</div><div class="std-acks">`;
                for (const a of acks) html += `<span class="std-ack">${esc(a)}</span>`;
                html += '</div>';
            }
            return html;
        }

        async function loadInjectionConfig() {
            const url = injState.scope === "project"
                ? `${API}/api/injection/config?project=${encodeURIComponent(injState.project)}`
                : `${API}/api/injection/config`;
            try {
                const res = await fetch(url);
                const json = await res.json();
                if (injState.scope === "project") {
                    injState.config = json.effective;
                    injState.hasOverride = Object.keys(json.override || {}).length > 0;
                    injState.override = json.override || {};
                } else {
                    injState.config = json.global;
                    injState.overrides = json.overrides || {};
                }
            } catch { injState.config = null; }
        }

        async function loadInjectionHistory() {
            try {
                const res = await fetch(`${API}/api/injections?project=${encodeURIComponent(injState.project)}&limit=50`);
                const json = await res.json();
                injState.history = json.items || [];
            } catch { injState.history = []; }
        }

        async function loadInjectionPreview() {
            try {
                const res = await fetch(`${API}/api/inject/preview?project=${encodeURIComponent(injState.project)}`);
                const json = await res.json();
                return json;
            } catch { return { content: "", chars: 0 }; }
        }

        async function renderInjectionPanel() {
            const body = document.getElementById('injBody');
            const c = injState.config || {};
            const overrideHint = injState.scope === "project" && injState.hasOverride
                ? `<div class="inj-override-note">⚙️ هذا المشروع له إعدادات خاصة تطغى على العام <button class="inj-clear-override" data-action="clear-injection-override">إزالة التخصيص</button></div>`
                : "";

            const dynamicRows = ["sessionStart","userPromptSubmit","preToolUseRead","outdatedLibs","describeNudge","upcomingItems"].map(k => {
                const m = injTypeMeta[k];
                return `<div class="inj-toggle-row">
                    <div>
                        <div class="inj-toggle-label">${esc(m.label)}</div>
                        <span class="inj-toggle-sub">${esc(m.sub)}</span>
                    </div>
                    <div class="inj-switch ${c[k] ? 'on' : ''}" data-action="toggle-injection" data-key="${esc(k)}" data-value="${c[k] ? 'false' : 'true'}"></div>
                </div>`;
            }).join("");

            // Standards enforcement — per-project only (writes a .devlog marker).
            // Default ON (undefined ⇒ on). Shown in the project tab; the global
            // tab points the user to the project tab since markers are per-project.
            const em = injTypeMeta.standardsEnforce;
            const enforceOn = c.standardsEnforce !== false;
            const enforceGroup = injState.scope === "project"
                ? `<div class="inj-group">
                    <div class="inj-group-title">الإجبار</div>
                    <div class="inj-toggle-row">
                        <div>
                            <div class="inj-toggle-label">${esc(em.label)}</div>
                            <span class="inj-toggle-sub">${esc(em.sub)}</span>
                        </div>
                        <div class="inj-switch ${enforceOn ? 'on' : ''}" data-action="toggle-injection" data-key="standardsEnforce" data-value="${enforceOn ? 'false' : 'true'}"></div>
                    </div>
                </div>`
                : `<div class="inj-group">
                    <div class="inj-group-title">الإجبار</div>
                    <div class="inj-empty">إجبار المعايير يُضبط لكل مشروع — افتح تبويب «خاص بالمشروع».</div>
                </div>`;

            const staticRows = ["claudeMd","contextMd"].map(k => {
                const m = injTypeMeta[k];
                return `<div class="inj-toggle-row">
                    <div>
                        <div class="inj-toggle-label">${esc(m.label)}</div>
                        <span class="inj-toggle-sub">${esc(m.sub)}</span>
                    </div>
                    <div class="inj-switch disabled ${c[k] ? 'on' : ''}" title="قيد التطوير"></div>
                </div>`;
            }).join("");

            const preview = await loadInjectionPreview();
            const histHtml = injState.history.length === 0
                ? '<div class="inj-empty">لا توجد حقنات مسجلة لهذا المشروع</div>'
                : injState.history.map(h => `<div class="inj-hist-item">
                    <span class="inj-hist-type">${esc(h.type)}</span>
                    <span style="flex:1"></span>
                    <span class="inj-hist-size">${h.chars}ح</span>
                    <span class="inj-hist-time">${new Date(h.timestamp).toLocaleString('ar-SA', {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</span>
                    <button class="inj-hist-view" data-action="show-injection-content" data-id="${esc(h.id)}">عرض</button>
                </div>`).join("");

            body.innerHTML = `
                <div class="inj-section">
                    <div class="inj-scope-tabs">
                        <button class="inj-scope-tab ${injState.scope==='global'?'active':''}" data-action="switch-inj-scope" data-scope="global">الإعدادات العامة</button>
                        <button class="inj-scope-tab ${injState.scope==='project'?'active':''}" data-action="switch-inj-scope" data-scope="project">خاص بالمشروع</button>
                    </div>
                    ${overrideHint}
                    <div class="inj-group">
                        <div class="inj-group-title">حقن ديناميكي (لـ Claude)</div>
                        ${dynamicRows}
                    </div>
                    ${enforceGroup}
                    <div class="inj-group">
                        <div class="inj-group-title">حقن ثابت (ملفات المشروع)</div>
                        ${staticRows}
                    </div>
                </div>
                <div class="inj-section">
                    <h4>معاينة حية (${preview.chars} حرف)</h4>
                    <div class="inj-preview">${esc(preview.content || '— لا يوجد محتوى يُحقن حالياً —')}</div>
                    <div class="inj-preview-meta">هذا ما سيُحقن الآن لو بدأت جلسة جديدة في هذا المشروع.</div>
                    <h4 style="margin-top:14px">السجل التاريخي (${injState.history.length})</h4>
                    <div class="inj-history">${histHtml}</div>
                </div>
            `;
        }

        export async function switchInjScope(scope) {
            injState.scope = scope;
            await loadInjectionConfig();
            renderInjectionPanel();
        }

        export async function toggleInjection(key, val) {
            const patch = { [key]: val === 'true' || val === true };
            const body = injState.scope === "project"
                ? { project: injState.project, config: patch }
                : { config: patch };
            await fetch(`${API}/api/injection/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            await loadInjectionConfig();
            renderInjectionPanel();
        }

        export async function clearInjectionOverride() {
            await fetch(`${API}/api/injection/config?project=${encodeURIComponent(injState.project)}`, { method: "DELETE" });
            await loadInjectionConfig();
            renderInjectionPanel();
        }

        export function showInjectionContent(id) {
            const item = injState.history.find(h => h.id === id);
            if (!item) return;
            const w = window.open("", "_blank", "width=780,height=600");
            w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>حقنة ${esc(item.type)}</title>
                <style>body{background:#0a1420;color:#eaeaea;font-family:'Cascadia Code',Consolas,monospace;padding:20px;font-size:13px;white-space:pre-wrap;direction:ltr;text-align:left}h3{color:#ffd166}</style></head>
                <body><h3>${esc(item.type)} · ${esc(String(item.chars))} chars · ${esc(new Date(item.timestamp).toLocaleString())}</h3><hr>${esc(item.content)}</body></html>`);
        }

        // ===== Init =====

        window.addEventListener('hashchange', () => {
            const name = projectFromHash();
            if (name && name !== activeProject && data.projects?.[name]) selectProject(name);
        });

        // Reflect runtime feature flags on <body>; the CSS hides the vuln UI
        // when the scanner isn't reachable. Re-checked alongside main data so
        // a scanner that comes online mid-session lights the button back up.
        async function fetchConfig() {
            try {
                const r = await fetch(`${API}/api/config`);
                if (!r.ok) return;
                const c = await r.json();
                document.body.dataset.vulnEnabled = c.vulnEnabled ? "true" : "false";
            } catch {
                // Unreachable server: keep the current flag until the next probe.
            }
        }

        // Tool-update probe: render a small badge if a newer release exists
        // for devlog or vuln. The actual GitHub fetch happens server-side
        // (see /api/updates + version-check.ts) — we just display the cached
        // result here so the dashboard never blocks on outbound HTTP.
        let updatesState = null;
        async function fetchUpdates() {
            try {
                const r = await fetch(`${API}/api/updates`);
                if (!r.ok) return;
                updatesState = await r.json();
                renderUpdatesBadge();
            } catch {
                // Best-effort probe: no badge is a fine fallback.
            }
        }
        function renderUpdatesBadge() {
            const badge = document.getElementById("updates-badge");
            if (!badge || !updatesState) return;
            const tools = (updatesState.tools || []).filter(t => t.hasUpdate);
            if (tools.length === 0) { badge.style.display = "none"; return; }
            const names = tools.map(t => `${t.name} → v${t.latestVersion}`).join("، ");
            badge.textContent = `🔄 ${tools.length === 1 ? "تحديث" : `${tools.length} تحديثات`} متاحة`;
            badge.title = `${names}\n(انقر للتفاصيل)`;
            badge.style.display = "inline-block";
        }
        export function openUpdatesPopup() {
            if (!updatesState) return;
            const tools = (updatesState.tools || []).filter(t => t.hasUpdate);
            if (tools.length === 0) return;
            const lines = tools.map(t => {
                const date = t.latestReleaseDate ? new Date(t.latestReleaseDate).toLocaleDateString() : "";
                return `${t.name}: v${t.localVersion || "?"} → v${t.latestVersion}${date ? ` (${date})` : ""}\n${t.latestUrl || ""}`;
            }).join("\n\n");
            // Show the right upgrade path: a plugin install updates from inside
            // Claude Code, a clone updates with git.
            const how = updatesState.pluginMode
                ? "\n\nللتحديث داخل Claude Code:\n/plugin marketplace update"
                : "\n\nللتحديث:\ngit pull ثم أعد تشغيل الخادم";
            uiAlert(`تحديثات متاحة:\n\n${lines}${how}`, "تحديثات متاحة");
        }

        // Bootstrap moved into initDashboard() (R3 #3): with modules, this file
        // evaluates BEFORE dashboard-core.js in the cycle order, so running the
        // initial fetch here hit core's `const API` in its TDZ — a ReferenceError
        // swallowed by fetchData's catch, leaving a blank page with a clean
        // console. The entry point calls init AFTER the whole graph evaluated.
        export function initDashboard() {
            fetchConfig();
            fetchUpdates();
            setInterval(fetchConfig, 60_000);
            setInterval(fetchUpdates, 15 * 60_000);   // re-poll the cache every 15 min
            // #373: the landing screen needs only the sidebar → summary (KBs).
            // R3 #4: a #project= deep-link opens through selectProject, which
            // lazy-fetches that one project's view instead of the full store.
            const fromHash = projectFromHash();
            if (fromHash) selectProject(fromHash); else fetchSummary();
            wsConnect();
        }

        // WebSocket
        // ===== Live Banner =====

        let liveBannerTimeout = null;
        const toolColors = { Create: '#04201a', Edit: '#2a2008', Read: '#082030', Bash: '#2a0a18', PowerShell: '#2a0a18', Agent: '#1a0a2a', Plan: '#2a2008' };
        const toolTextColors = { Create: 'var(--emerald)', Edit: 'var(--gold)', Read: 'var(--blue)', Bash: 'var(--pink)', PowerShell: 'var(--pink)', Agent: '#bb86fc', Plan: 'var(--gold)' };

        function showLiveBanner(msg) {
            const banner = document.getElementById('liveBanner');
            if (!banner) return;
            const tool = msg.tool || msg.event || '';
            const filePath = msg.file_path || '';
            const fname = filePath ? filePath.replace(/\\/g,'/').split('/').pop() : '';
            const desc = fname || msg.description?.slice(0,40) || tool;
            const bgColor = toolColors[tool] || 'var(--bg3)';
            const txtColor = toolTextColors[tool] || 'var(--text2)';

            banner.style.background = bgColor;
            banner.style.opacity = '1';
            banner.innerHTML = `<span class="pulse"></span>
                <span class="tool-badge" style="color:${txtColor}">${esc(tool)}</span>
                <span class="file-path">${esc(desc)}</span>`;

            // Highlight file in tree
            if (tool === "Create") {
                // Wait for tree to rebuild then highlight
                setTimeout(() => highlightFile(filePath, true), 1500);
            } else {
                highlightFile(filePath, false);
            }

            clearTimeout(liveBannerTimeout);
            liveBannerTimeout = setTimeout(() => { banner.style.opacity = '0'; }, 8000);
        }

        function highlightFile(filePath, isNew) {
            if (!filePath) return;
            document.querySelectorAll('.tree-file.active-file, .tree-file.new-file').forEach(el => {
                el.classList.remove('active-file', 'new-file');
            });
            const norm = filePath.replace(/\\/g, '/');
            document.querySelectorAll('.tree-file').forEach(el => {
                const dir = (el.getAttribute('data-dir') || '').replace(/\\/g, '/');
                const name = el.getAttribute('data-name') || '';
                const full = `${dir}/${name}`;
                if (norm === full || norm.endsWith(full)) {
                    el.classList.add(isNew ? 'new-file' : 'active-file');
                }
            });
        }

        // ===== WebSocket =====

        let ws = null;
        let wsRetry = 1000;
        let pingInterval = null;
        let refreshQueued = false;

        function wsConnect() {
            ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws`);
            ws.onopen = () => {
                wsRetry = 1000;
                pingInterval = setInterval(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
                }, 15000);
            };
            ws.onmessage = (e) => {
                if (e.data === "pong") return;
                try {
                    const msg = JSON.parse(e.data);
                    // Live banner for hook events
                    if (msg.type === "hook" && msg.payload) {
                        showLiveBanner(msg.payload);
                    }
                    // Tree-changing events need full render; others use surgical patch
                    if (msg.type === "scan" || (msg.type === "hook" && msg.payload && (msg.payload.tool === "Create" || msg.payload.type === "create" || ((msg.payload.tool === "Bash" || msg.payload.tool === "PowerShell") && /rm |del |remove-item/i.test(msg.payload.command || msg.payload.description || ''))))) {
                        setFullRenderNeeded(true);
                        setCachedTree(null);
                    }
                    // Debounce data refresh — summary is enough while no
                    // project is open (#373); an open project refreshes its
                    // own lazy view, never the whole store (R3 #4).
                    if (!refreshQueued) {
                        refreshQueued = true;
                        setTimeout(() => {
                            refreshQueued = false;
                            refreshActiveView();
                        }, 500);
                    }
                } catch {
                    // Malformed WS frame: skip it, the next pulse resyncs.
                }
            };
            ws.onclose = () => {
                clearInterval(pingInterval);
                setTimeout(wsConnect, wsRetry);
                wsRetry = Math.min(wsRetry * 1.5, 15000);
            };
            ws.onerror = () => {
                try { ws.close(); } catch {
                    // Socket already dead — onclose handles the reconnect.
                }
            };
        }
