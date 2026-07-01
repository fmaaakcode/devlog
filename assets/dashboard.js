        // Derive from where the dashboard is served, so it follows DEVLOG_PORT
        // instead of hardcoding 7777 (R3 P5).
        const API = location.origin;
        let data = { projects: {}, events: [], tags: [], plans: [], worklog: [] };
        let activeProject = null;

        // Foreground colors for tool badges — single source (was duplicated in
        // updateCards + renderFiles with a drifted Agent shade) (R3 P7). The
        // dark background tints near the file tree are a separate concept.
        const TOOL_FG_COLORS = { Create: 'var(--emerald)', Edit: 'var(--gold)', Read: 'var(--blue)', Bash: 'var(--pink)', Agent: '#bb86fc', Plan: 'var(--gold)' };

        // Allow only http(s) links; blocks javascript:/data: URIs coming from an
        // untrusted git remote (.git/config) or vuln API (security audit D3).
        function safeHref(url) {
            const u = String(url || "").trim();
            return /^https?:\/\//i.test(u) ? u : "#";
        }
        let logFilter = "all";

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
                showCompletedPlans = !showCompletedPlans;
                renderActivePlanCard(activeProject);
            }
            else if (action === "delete-tag") {
                e.stopPropagation();
                deleteTag(el.dataset.tagId, el.dataset.tagKind);
            }
            // Converted from inline onclick (R3 P7) — keeps CSP free of the
            // remaining unsafe-inline handlers.
            else if (action === "set-log-filter") setLogFilter(el.dataset.key);
            else if (action === "close-sessions-modal") { const m = document.getElementById('sessionsModal'); if (m) m.remove(); }
            else if (action === "clear-injection-override") clearInjectionOverride();
            else if (action === "toggle-injection") toggleInjection(el.dataset.key, el.dataset.value === 'true');
            else if (action === "show-injection-content") showInjectionContent(el.dataset.id);
            else if (action === "switch-inj-scope") switchInjScope(el.dataset.scope);
            else if (action === "show-vulns") showVulnsModal(el.dataset.project, el.dataset.lib);
            else if (action === "show-vulns-tag") showVulnsFromTag(el.dataset.project, el.dataset.content);
            else if (action === "close-vulns-modal") { const m = document.getElementById('vulnsModal'); if (m) m.remove(); }
            else if (action === "noop") { /* swallow clicks inside a modal so the backdrop doesn't close it */ }
        });

        async function deleteTag(tagId, kind) {
            const label = kind === "security" ? "ثغرة" : kind === "bug" ? "خلل" : "تاق";
            if (!confirm(`حذف هذه الـ${label} نهائياً؟\nاستخدم هذا فقط للـfalse positive أو الإدخال الخاطئ. للإصلاح الفعلي استخدم -(security fix) #N أو -(bug fix) #N.`)) return;
            try {
                const res = await fetch(`${API}/api/tag/${encodeURIComponent(tagId)}`, { method: "DELETE" });
                if (res.ok) {
                    data.tags = (data.tags || []).filter(t => t.id !== tagId);
                    if (typeof renderProject === "function") renderProject();
                } else {
                    alert("فشل الحذف");
                }
            } catch (e) {
                alert("خطأ: " + e.message);
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
            const vulns = (vulnCache && vulnCache[project]) || (data.projects[project] && data.projects[project].vulnResults) || {};
            const v = vulns[lib];
            const sevColors = { critical: '#ff1744', high: '#ff5252', moderate: '#ff9800', low: '#ffd93d', none: 'var(--text2)' };
            let titleCount = '';
            let fixLine = '';
            let rows;
            if (v && v.vulns > 0) {
                titleCount = ` — ${v.vulns}`;
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
                        const fix = a.fix
                            ? `<span class="vuln-row-fix">fix ${esc(a.fix)}</span>`
                            : `<span class="vuln-row-nofix">لا إصلاح</span>`;
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
                const has = proj.about && proj.about.trim();
                show(btn, {
                    name: proj.name,
                    description: proj.description || "",
                    body: has ? proj.about : "لا يوجد محتوى about لهذا المشروع. أرسل `-(about) ...` لإضافته.",
                });
            }

            const isHoverable = (target) =>
                target && target.closest && (target.closest(".mem-row") || target.closest("[data-about-btn]") || target.closest("#memPopover"));

            document.addEventListener("mouseover", (e) => {
                const row = e.target.closest(".mem-row");
                if (row) { showFromRow(row); return; }
                const aboutBtn = e.target.closest("[data-about-btn]");
                if (aboutBtn) { showFromAbout(aboutBtn); return; }
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
                el.style.left = Math.max(8, left) + "px";
                el.style.top = top + "px";
            }
        })();

        const langColors = {
            TypeScript: "#3178c6", JavaScript: "#f7df1e", Python: "#3776ab",
            Rust: "#dea584", Go: "#00add8", Java: "#ed8b00", "C#": "#68217a",
            PHP: "#777bb4", Ruby: "#cc342d", Swift: "#fa7343", Dart: "#0175c2",
            Vue: "#42b883", Svelte: "#ff3e00", default: "#118ab2"
        };

        const tagLabels = {
            plan: "خطة", built: "بناء", todo: "مهمة", done: "منجز", dropped: "ملغي",
            "bug found": "خلل", "bug fix": "إصلاح", security: "أمني", "security fix": "إصلاح أمني",
            release: "إصدار", note: "ملاحظة", update: "تحديث", refactor: "إعادة هيكلة", outdated: "قديم",
            decision: "قرار", insight: "تحقيق",
            "security:dep": "أمني (تبعية)", "security:own": "أمني (كود)"
        };

        const tagDotColors = {
            plan: "var(--blue)", built: "var(--emerald)", todo: "var(--gold)",
            done: "var(--emerald)", dropped: "var(--text2)",
            "bug found": "var(--pink)", "bug fix": "var(--emerald)",
            security: "var(--pink)", "security fix": "var(--emerald)", outdated: "var(--gold)",
            release: "var(--gold)", note: "var(--text2)",
            update: "var(--emerald)", refactor: "var(--blue)",
            decision: "#06b6d4", insight: "#a78bfa",
            "security:dep": "var(--gold)", "security:own": "var(--pink)"
        };

        // Filter groups for log tab
        const filterGroups = {
            all: null,
            build: ["built", "refactor", "update"],
            bugs: ["bug found", "bug fix"],
            security: ["security", "security fix", "security:dep", "security:own", "outdated"],
            tasks: ["plan", "todo", "done", "dropped"],
            knowledge: ["decision", "insight", "note"],
            other: ["release"]
        };
        const filterLabels = {
            all: "الكل", build: "البناء", bugs: "الأخطاء",
            security: "الأمان", tasks: "المهام", knowledge: "معرفة", other: "أخرى"
        };

        // Mirror of SECURITY_OPEN_TAGS in src/data.ts — the opener tags that count
        // as a security item. The dashboard used to filter `t.tag === "security"`
        // alone, silently dropping `security:own`/`security:dep` from every count
        // and list (e.g. project-x #103 showed open in ?open but vanished here).
        const SEC_OPEN_TAGS = new Set(["security", "security:own", "security:dep"]);

        function esc(s) {
            if (!s) return "";
            return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
        }
        // Compact display: tags may now hold body up to 2000 chars; the dashboard
        // shows only the first line + ~120 chars to keep rows scannable.
        function tagSummary(s, max = 120) {
            if (!s) return "";
            const firstLine = s.split("\n")[0];
            return firstLine.length > max ? firstLine.slice(0, max - 1) + "…" : firstLine;
        }
        // Mirror of export.ts fuzzyMatch: same prefix logic so the dashboard
        // closes a todo whenever the corresponding done would close it in the
        // generated DEVLOG_STATUS.md. Avoids the "I emitted done but it's
        // still open" frustration.
        // Mirror of export.ts sharedPrefixClose: a shared prefix only counts as a
        // match when it covers most of both strings (≥25 chars AND ≥80% of the
        // longer), so "… Finding #2" and "… Finding #3" don't close each other.
        function sharedPrefixClose(na, nb) {
            if (na.length <= 10 || nb.length <= 10) return false;
            let i = 0;
            const min = Math.min(na.length, nb.length);
            while (i < min && na[i] === nb[i]) i++;
            return i >= 25 && i >= 0.8 * Math.max(na.length, nb.length);
        }
        function isDoneFuzzy(itemLow, doneTextsArr) {
            if (doneTextsArr.has(itemLow)) return true;
            for (const d of doneTextsArr) {
                if (sharedPrefixClose(itemLow, d)) return true;
            }
            return false;
        }
        function timeStr(ts) {
            return new Date(ts).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
        }
        function tagClass(tag) { return tag.replace(/[\s:]+/g, ""); }
        // For closure tags whose content is `#N` or `Pn(.m)`, show a richer
        // label by looking up the original item. Falls back to raw content.
        function resolveTagDisplay(t, allTags, plans) {
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
        // Same normalization the server uses for closure matching: strip
        // inline-code backticks, collapse whitespace, lowercase, trim. Without
        // it the dashboard disagrees with the server about which todos are
        // open whenever the original text contains backticks or stray spaces.
        function normTag(s) {
            return s.replace(/`[^`\n]*`/g, ' ').replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        }
        function fuzzy(a, b) {
            const na = normTag(a), nb = normTag(b);
            return na === nb || na.includes(nb) || nb.includes(na) || sharedPrefixClose(na, nb);
        }
        // Mirror of data.ts closedNums: numbers closed via `-(kind) #N` for the
        // given (type-matched) closure kinds. The dashboard MUST honor numeric
        // closures — the tag protocol tells Claude to close by `#N`, and that
        // closure's content ("#4") never text-matches the item, so without this
        // every #N-closed todo/bug/security shows open on the dashboard forever
        // even though the server (?open, export, doctor) treats it as closed.
        function closedNumSet(tags, kinds) {
            const nums = new Set();
            for (const t of tags) {
                if (!kinds.includes(t.tag)) continue;
                for (const m of (t.content || '').matchAll(/#(\d+)/g)) nums.add(parseInt(m[1], 10));
            }
            return nums;
        }

        // ===== Data fetching =====

        let lastDataHash = '';
        let fullRenderNeeded = true;
        let activeSessionsByProject = {};

        async function refreshActiveSessions() {
            try {
                const r = await fetch(API + "/api/sessions");
                const j = await r.json();
                const map = {};
                for (const s of (j.items || [])) {
                    const name = (s.cwd || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'unknown';
                    if (!map[name]) map[name] = [];
                    map[name].push(s.pid);
                }
                activeSessionsByProject = map;
            } catch {}
        }

        async function fetchData(forceRender) {
            try {
                const [res] = await Promise.all([
                    fetch(API + "/api/data"),
                    refreshActiveSessions(),
                ]);
                const newData = await res.json();
                const proj = newData.projects?.[activeProject];
                const lastEv = newData.events?.length ? newData.events[newData.events.length - 1] : null;
                const lastTag = newData.tags?.length ? newData.tags[newData.tags.length - 1] : null;
                const projectPlans = (newData.plans || []).filter(p => p.project === activeProject);
                const newHash = JSON.stringify({
                    tags: newData.tags?.length, lastTagId: lastTag?.id,
                    events: newData.events?.length, lastEventId: lastEv?.id,
                    projects: Object.keys(newData.projects || {}).length,
                    libs: proj?.libraries?.length, files: proj?.totalFiles, fileExts: proj?.files, desc: proj?.description,
                    plans: projectPlans.length,
                    planSteps: projectPlans.map(p => `${p.title}|${p.steps.filter(s => s.completed).length}/${p.steps.length}`).join(";"),
                });
                const changed = newHash !== lastDataHash;
                data = newData;
                lastDataHash = newHash;

                if (!activeProject) {
                    const fromHash = projectFromHash();
                    if (fromHash && newData.projects?.[fromHash]) {
                        selectProject(fromHash);
                        return;
                    }
                }

                renderSidebar();
                if (activeProject && (fullRenderNeeded || forceRender)) {
                    fullRenderNeeded = false;
                    renderProject();
                } else if (activeProject && changed) {
                    // Surgical update — patch header + update cards, no tree refetch
                    patchHeader();
                    updateCards();
                }
            } catch {}
        }

        function flashCard(id) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove('card-updated');
                void el.offsetWidth;
                el.classList.add('card-updated');
            }
        }

        // Track previous content hash per card — only flash on actual change
        const cardHashes = {};
        function updateCard(id, html) {
            const el = document.getElementById(id);
            if (!el) return;
            const prev = cardHashes[id];
            cardHashes[id] = html;
            if (prev === html) return; // no change — skip
            el.innerHTML = html;
            if (prev !== undefined) flashCard(id); // don't flash on first render
        }

        function updateCards() {
            const tags = getProjectTags();
            const plans = (data.plans || []).filter(p => p.project === activeProject);
            const p = data.projects[activeProject];

            // Update events card — shared builder, identical to the full render.
            updateCard('eventsCard', buildEventsHtml(data.events, activeProject));

            // Update tags card
            if (tags.length > 0) {
                const filtered = logFilter === "all" ? tags : tags.filter(t => filterGroups[logFilter]?.includes(t.tag));
                let tgH = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">التاقات</div>`;
                tgH += '<div class="log-filters">';
                for (const [key, label] of Object.entries(filterLabels)) {
                    const count = key === "all" ? tags.length : tags.filter(t => filterGroups[key].includes(t.tag)).length;
                    if (key !== "all" && count === 0) continue;
                    tgH += `<button class="log-filter${logFilter === key ? ' active' : ''}" data-action="set-log-filter" data-key="${esc(key)}">${esc(label)} <span class="tab-badge tab-badge-default">${count}</span></button>`;
                }
                tgH += '</div><div style="overflow-y:auto;flex:1;min-height:0">';
                for (const t of filtered) {
                    const tc = tagClass(t.tag);
                    const sec = t.tag === 'security'
                        ? ` data-action="show-vulns-tag" data-project="${esc(activeProject)}" data-content="${esc(t.content)}" style="cursor:pointer;text-decoration:underline dotted"`
                        : '';
                    const ttl = t.tag === 'security' ? `${t.content} — اضغط لتفاصيل الثغرات` : t.content;
                    tgH += `<div class="log-item item-new${t.breaking ? ' is-breaking' : ''}">
                        <div class="log-bar bar-${tc}"></div>
                        <span class="log-tag tag-${tc}">${esc(tagLabels[t.tag] || t.tag)}</span>
                        <span class="log-content"${sec} title="${esc(ttl)}">${esc(tagSummary(t.content))}</span>
                        <span class="log-time">${timeStr(t.timestamp)}</span>
                    </div>`;
                }
                tgH += '</div>';
                updateCard('cardTags', tgH);
            }

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

        async function rescanProject(name, btn) {
            btn.classList.add("loading");
            btn.textContent = "جاري المسح...";
            try {
                await fetch(`${API}/api/scan/${encodeURIComponent(name)}`, { method: "POST" });
                headerBuilt = false;
                cachedTree = null;
                await fetchData(true);
            } catch {}
            btn.classList.remove("loading");
            btn.textContent = "إعادة مسح";
        }

        function setVulnStatus(panel, msg, color = 'var(--text2)', spinner = false) {
            const spin = spinner ? '<span class="vuln-spinner"></span>' : '';
            // esc(msg): msg can carry err.message (see vulnScan catch) — never raw into innerHTML (R3 P5)
            panel.innerHTML = `<div style="display:flex;align-items:center;gap:8px;font-size:0.78em;color:${color}">${spin}<span>${esc(msg)}</span></div>`;
            panel.style.display = "flex";
        }

        async function vulnScan(name, btn) {
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
        const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

        function renderProjectItem(name) {
            const p = data.projects[name];
            const tagCount = (data.tags || []).filter(t => t.project === name).length;
            const color = langColors[p.language] || langColors.default;
            const vulnCls = projectVulnClass(p);
            const title = vulnCls === 'vuln-danger' ? 'يحتوي مكتبات ذات ثغرات أمنية'
                        : vulnCls === 'vuln-warn' ? 'يحتوي مكتبات غير محدثة'
                        : vulnCls === 'vuln-safe' ? 'كل المكتبات سليمة ومحدثة'
                        : '';
            const livePids = activeSessionsByProject[name] || [];
            const liveDot = livePids.length
                ? `<span class="project-live" title="جلسة Claude Code شغّالة · PID ${livePids.join(', ')}"></span>`
                : '';
            const itemTitle = title || (livePids.length ? `جلسة شغّالة · PID ${livePids.join(', ')}` : '');
            return `<div class="project-item ${activeProject === name ? 'active' : ''} ${vulnCls}" data-action="select-project" data-project="${esc(name)}" ${itemTitle ? `title="${esc(itemTitle)}"` : ''}>
                <span class="project-dot" style="background:${color}"></span>
                <span class="project-item-name">${esc(name)}</span>
                <span class="project-item-count">${tagCount}</span>
                ${liveDot}
                <button class="project-rename" data-action="rename-project" data-project="${esc(name)}" title="إعادة تسمية المشروع">✎</button>
                <button class="project-delete" data-action="delete-project" data-project="${esc(name)}" title="حذف المشروع">✕</button>
            </div>`;
        }

        function renderSidebar() {
            const elActive = document.getElementById("projectListActive");
            const elOther = document.getElementById("projectListOther");
            const names = Object.keys(data.projects);
            if (names.length === 0) {
                elActive.innerHTML = '<div class="sidebar-empty">لا توجد مشاريع بعد<br>ابدأ العمل في أي مشروع وسيظهر هنا تلقائياً</div>';
                elOther.innerHTML = '';
                return;
            }
            const lastActivity = {};
            for (const t of (data.tags || [])) {
                const ts = +new Date(t.timestamp) || 0;
                if (ts > (lastActivity[t.project] || 0)) lastActivity[t.project] = ts;
            }
            for (const e of (data.events || [])) {
                const ts = +new Date(e.timestamp) || 0;
                if (ts > (lastActivity[e.project] || 0)) lastActivity[e.project] = ts;
            }
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

            elActive.innerHTML = renderCard("نشطة (آخر 7 أيام)", active, "لا توجد مشاريع نشطة");
            elOther.innerHTML = renderCard("باقي المشاريع", other, "لا يوجد");
        }

        function projectVulnClass(p) {
            const vulns = (vulnCache && vulnCache[p.name]) || p.vulnResults || {};
            const libs = p.libraries || [];
            let hasDanger = false, hasWarn = false, scannedAny = false;
            for (const l of libs) {
                const v = vulns[l.name];
                if (!v || (v.status === "unscannable" || v.status === "unknown")) continue;
                scannedAny = true;
                if (v.icon === 'warning' || v.icon === 'x') { hasDanger = true; break; }
                if (v.isLatest === false && l.version !== 'latest') hasWarn = true;
            }
            if (hasDanger) return 'vuln-danger';
            if (hasWarn) return 'vuln-warn';
            if (scannedAny) return 'vuln-safe';
            return '';
        }

        async function renameProject(name) {
            const next = prompt(`إعادة تسمية المشروع "${name}"\nسيُعاد تسمية مجلده على القرص أيضاً (إن وُجد)، وتنتقل التاقات والميموري.`, name);
            if (next === null) return;                 // cancelled
            const newName = next.trim();
            if (!newName || newName === name) return;
            try {
                const res = await fetch(`${API}/api/project/${encodeURIComponent(name)}/rename`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ newName }),
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok) { alert(result.error || "تعذّرت إعادة التسمية"); return; }
                // Note what the server actually did (folder + memory) so the user
                // knows whether the on-disk folder moved and if any memory card
                // was left behind (not overwritten at the destination).
                const bits = [];
                if (result.movedFolder) bits.push(`المجلد → ${result.newPath}`);
                const mv = result.memory?.moved?.length || 0;
                const sk = result.memory?.skipped?.length || 0;
                if (mv) bits.push(`نُقل ${mv} بطاقة ميموري`);
                if (sk) bits.push(`تُخطّي ${sk} بطاقة موجودة مسبقاً`);
                if (bits.length) console.log("[rename]", bits.join(" · "));
                if (sk) alert(`تمّت إعادة التسمية.\nتُخطّي ${sk} بطاقة ميموري لوجود نظيرة لها في الوجهة (لم تُطمَس).`);
                // The WS "rename" broadcast refreshes data; switch selection if needed.
                if (activeProject === name) { activeProject = newName; headerBuilt = false; cachedTree = null; }
                await fetchData(true);
            } catch { alert("تعذّر الاتصال بالخادم"); }
        }

        async function deleteProject(name) {
            if (!confirm(`حذف المشروع "${name}"؟\nسيتم حذف جميع التاقات والأحداث المرتبطة به.`)) return;
            try {
                const res = await fetch(`${API}/api/project/${encodeURIComponent(name)}`, { method: "DELETE" });
                if (res.ok) {
                    delete data.projects[name];
                    data.tags = (data.tags || []).filter(t => t.project !== name);
                    data.plans = (data.plans || []).filter(p => p.project !== name);
                    data.events = (data.events || []).filter(e => e.project !== name);
                    if (activeProject === name) {
                        activeProject = Object.keys(data.projects)[0] || "";
                        headerBuilt = false;
                        cachedTree = null;
                        if (activeProject) {
                            renderSidebar();
                            renderProject();
                        } else {
                            document.getElementById("projectView").style.display = "none";
                            document.getElementById("welcome").style.display = "flex";
                            document.getElementById("topbarLeft").innerHTML = "";
                            document.getElementById("topbar").classList.remove("has-project");
                            renderSidebar();
                        }
                    } else {
                        renderSidebar();
                    }
                }
            } catch {}
        }

        function selectProject(name) {
            activeProject = name;
            fullRenderNeeded = true;
            headerBuilt = false;
            cachedTree = null;
            document.getElementById("welcome").style.display = "none";
            document.getElementById("projectView").style.display = "flex";
            const newHash = name ? `#project=${encodeURIComponent(name)}` : '';
            if (location.hash !== newHash) history.replaceState(null, '', newHash || location.pathname);
            renderSidebar();
            renderProject();
            // Smart auto-rescan if manifests changed since last scan (server fires async, broadcasts via WS)
            fetch(`${API}/api/check-stale/${encodeURIComponent(name)}`, { method: "POST" }).catch(() => {});
        }

        function projectFromHash() {
            const m = location.hash.match(/project=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : null;
        }

        function getProjectTags() {
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

        let headerBuilt = false; // track if header structure exists

        // Shared about-button state (#229). buildHeaderOnce renders it and
        // patchHeader live-refreshes it — both must agree on the class + title,
        // so the rule lives here once instead of in two literals that can drift.
        function aboutBtnAttrs(hasAbout) {
            return {
                cls: 'about-btn ' + (hasAbout ? 'has-about' : 'no-about'),
                title: hasAbout ? 'مرر الماوس لعرض التفاصيل' : 'لا يوجد about — أرسل -(about) لإضافته',
            };
        }

        function buildHeaderOnce(p, tags) {
            const color = langColors[p.language] || langColors.default;
            const lastRelease = tags.find(t => t.tag === "release");
            const versionMatch = lastRelease?.content.match(/v[\d.]+/);
            const versionStr = versionMatch ? versionMatch[0] : "";

            // Topbar left: name + version + 3 small badges (lang, framework, runtime) + dependencies button
            document.getElementById("topbarLeft").innerHTML = `
                <span class="brand-name" id="hdr-name">${esc(p.name)}</span>
                <span class="brand-version" id="hdr-version" style="${versionStr ? '' : 'display:none'}">${esc(versionStr)}</span>
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
                ${p.runtime ? `<span id="hdr-runtime" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#7c8cf5;font-weight:600">${esc(p.runtime.name || '')}${p.runtime.version ? ' ' + esc(p.runtime.version) : ''}${p.runtime.edition ? ' · ' + esc(p.runtime.edition) : ''}</span>` : ''}
                ${p.gitRemote ? `<a href="${esc(p.gitRepoSlug ? 'https://github.com/' + p.gitRepoSlug : safeHref(p.gitRemote))}" target="_blank" rel="noopener" id="hdr-git" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#0d1f2e;color:#7cc4f5;font-weight:600;text-decoration:none" title="${esc(p.gitRemote)}">🔗 ${esc(p.gitRepoSlug || 'remote')}</a>` : '<span id="hdr-git" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a1a;color:var(--text2);font-weight:600" title="No git remote configured">📁 local</span>'}
                <span id="hdr-sessions" data-action="open-sessions" data-project="${esc(p.name)}" style="display:none;font-size:0.7em;padding:2px 8px;border-radius:4px;background:#0d2e1f;color:#06d6a0;font-weight:600;cursor:pointer" title="جلسات Claude النشطة"></span>
            `;
            document.getElementById("topbar").classList.add("has-project");

            const hasAbout = !!(p.about && p.about.trim());
            const ab = aboutBtnAttrs(hasAbout);
            // Description text and the about button are SEPARATE siblings: patchHeader
            // updates #hdr-desc-text only, so the about button survives live patches.
            // Container shows if there's a description OR an about to view.
            document.getElementById("projectHeader").innerHTML = `
                <div id="hdr-desc" style="font-size:0.8em;color:var(--text2);direction:rtl;${(p.description || hasAbout) ? '' : 'display:none'}">
                    <span id="hdr-desc-text" style="${p.description ? '' : 'display:none'}">${esc(p.description || '')}</span>
                    <span class="${ab.cls}" data-about-btn="1" id="hdr-about-btn" title="${ab.title}">about</span>
                </div>
            `;
            headerBuilt = true;
            patchLibraries(p);
            patchFileExts(p);
            patchSessions(p.name);
            patchStatsButton(p, tags);
        }

        function patchStatsButton(p, tags) {
            const popup = document.getElementById('hdr-stats-popup');
            const countEl = document.getElementById('hdr-stats-count');
            if (!popup) return;

            const filesN = p.totalFiles || 0;
            const libsN = (p.libraries || []).length;
            const dirsN = (p.directories || []).length;
            const tagsN = tags.length;
            if (countEl) countEl.textContent = filesN;

            const exts = Object.entries(p.files || {}).sort((a, b) => b[1] - a[1]);

            let html = '<div class="stats-section-title">إحصائيات</div>';
            html += '<div class="stats-grid">';
            html += `<div class="stats-row"><span class="stats-key">ملف</span><span class="stats-value">${filesN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">مكتبة</span><span class="stats-value">${libsN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">مجلد</span><span class="stats-value">${dirsN}</span></div>`;
            html += `<div class="stats-row"><span class="stats-key">تاق</span><span class="stats-value">${tagsN}</span></div>`;
            html += '</div>';

            if (exts.length > 0) {
                html += '<div class="stats-section-title">أنواع الملفات</div>';
                html += '<div class="stats-grid">';
                for (const [ext, n] of exts) {
                    html += `<div class="stats-ext"><span class="ext-name">.${esc(ext)}</span><span class="ext-count">${n}</span></div>`;
                }
                html += '</div>';
            }

            popup.innerHTML = html;

            const btn = document.getElementById('hdr-stats');
            if (btn) {
                btn.title = 'اضغط لفتح خريطة المشروع';
                btn.onclick = (e) => {
                    if (e.target.closest('.stats-popup')) return;
                    window.open(`/stack-map.html?project=${encodeURIComponent(p.name)}`, '_blank');
                };
            }
        }

        let vulnCache = {}; // { projectName: { libName: vulnResult } }

        // Public registry page for a package, derived from the project language
        // (same ecosystem map the server scans against). Lets the user click a
        // library to verify the version/date manually. Returns '' for
        // ecosystems with no stable per-package page (C/C++/vcpkg).
        function registryUrl(language, name) {
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

        function patchLibraries(p) {
            // Use saved vulnResults from server if no fresh scan in cache
            const vulns = vulnCache[p.name] || p.vulnResults || {};
            patchDepsButton(p, vulns);
            const el = document.getElementById('hdr-libraries');
            if (!el) return;
            el.innerHTML = p.libraries.map(l => {
                const v = vulns[l.name];
                // Prefer status (Vuln API v0.2+); fall back to icon for older cached results.
                const isCveUpdate = v && (v.status === "update" || (!v.status && v.icon === "warning"));
                const isCveDanger = v && (v.status === "danger" || (!v.status && v.icon === "x"));
                const isBad = isCveUpdate || isCveDanger;
                const isDanger = isCveDanger || isCveUpdate;
                const isUpdate = isCveUpdate;
                const borderColor = isDanger ? 'var(--pink)' : isUpdate ? '#c53030' : v ? '#1a4a1a' : 'var(--border)';
                const bgColor = isDanger ? '#2a0a0a' : isUpdate ? '#1a0808' : v?.icon === "check" ? '#0a1a0a' : 'var(--bg3)';
                const nameColor = isBad ? 'var(--pink)' : v ? 'var(--emerald)' : 'var(--text)';
                // Prefer the API's detailsUrl (CVE page); otherwise fall back to
                // the package's registry page so every library stays clickable.
                let href = safeHref(v?.detailsUrl);
                if (href === '#') href = registryUrl(p.language, l.name) || '#';
                const nameTag = href !== '#'
                    ? `<a href="${esc(href)}" target="_blank" rel="noopener" title="فتح صفحة المكتبة" style="color:${nameColor};text-decoration:none;font-weight:${isBad ? '700' : '400'}">${esc(l.name)}</a>`
                    : `<span style="color:${nameColor}">${esc(l.name)}</span>`;
                const verColor = isBad ? 'var(--pink)' : 'var(--emerald)';
                const updateTarget = v?.fixVersion || v?.latestVersion || '';
                const fixVer = isBad && updateTarget ? `<span style="color:var(--emerald);margin-left:2px">→ ${esc(updateTarget)}</span>` : (!isBad && v && !v.isLatest && v.latestVersion && l.version !== 'latest') ? `<span style="color:var(--gold);margin-left:2px">→ ${esc(v.latestVersion)}</span>` : '';
                const sevColors = { critical: '#ff1744', high: '#ff5252', moderate: '#ff9800', low: '#ffd93d', none: 'var(--pink)' };
                const sev = (v?.severity || '').toLowerCase();
                const vulnColor = sevColors[sev] || 'var(--pink)';
                const vulnTitle = v && v.vulns > 0 ? `${v.vulns} ثغرة${v.topVuln ? ` — ${v.topVuln.id} (${v.topVuln.severity}${v.topVuln.score ? ' ' + v.topVuln.score : ''})` : ''}${sev && sev !== 'none' ? ` — خطورة: ${sev}` : ''}` : '';
                const vulnCount = v && v.vulns > 0 ? `<span data-action="show-vulns" data-project="${esc(p.name)}" data-lib="${esc(l.name)}" style="color:${vulnColor};margin-left:4px;font-size:0.85em;cursor:pointer" title="${esc(vulnTitle)} — اضغط للتفاصيل">⚠${v.vulns}${(sev === 'critical' || sev === 'high') ? '!' : ''}</span>` : '';
                const isOutdated = !isBad && v && v.isLatest === false && l.version !== 'latest';
                const outdatedBorder = isOutdated ? '#4a3a00' : '';
                const outdatedBg = isOutdated ? '#1a1500' : '';
                const finalBorder = isBad ? borderColor : (isOutdated ? outdatedBorder : borderColor);
                const finalBg = isBad ? bgColor : (isOutdated ? outdatedBg : bgColor);
                const outdatedBadge = isOutdated ? '<span style="color:var(--gold);margin-left:4px;font-size:0.8em" title="مكتبة قديمة">&#8635;</span>' : '';
                return `<span style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:${finalBg};border:1px solid ${finalBorder};font-family:'Cascadia Code',Consolas,monospace;transition:all 0.3s">${l.dev ? '<span style="font-size:0.85em;color:var(--text2);background:var(--border);padding:0 4px;border-radius:3px;margin-left:4px">dev</span>' : ''}${nameTag}<span style="color:${verColor};margin-left:4px">${esc(l.version)}</span>${fixVer}${vulnCount}${outdatedBadge}</span>`;
            }).join("");
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
            const anyScanned = libs.some(l => { const v = vulns[l.name]; return v && (v.status !== "unscannable" && v.status !== "unknown"); });
            if (anyScanned) {
                status = 'safe';
                for (const l of libs) {
                    const v = vulns[l.name];
                    if (!v || (v.status === "unscannable" || v.status === "unknown")) continue;
                    if (v.icon === 'warning' || v.icon === 'x') { status = 'danger'; break; }
                    if (v.isLatest === false && l.version !== 'latest') status = 'warn';
                }
            }
            btn.classList.remove('safe', 'warn', 'danger', 'unknown');
            btn.classList.add(status);

            // Sort: danger first, then warn, then safe, then unknown
            const rank = (l) => {
                const v = vulns[l.name];
                if (v && (v.icon === 'warning' || v.icon === 'x')) return 0;
                if (v && (v.status !== 'unscannable' && v.status !== 'unknown') && v.isLatest === false && l.version !== 'latest') return 1;
                if (v && (v.status !== 'unscannable' && v.status !== 'unknown')) return 2;
                return 3;
            };
            const sorted = [...libs].sort((a, b) => rank(a) - rank(b));

            if (libs.length === 0) {
                popup.innerHTML = '<div class="deps-empty">لا توجد مكتبات</div>';
                return;
            }
            popup.innerHTML = sorted.map(l => {
                const v = vulns[l.name];
                let cls = 'unknown';
                let target = '';
                if (v && (v.status !== 'unscannable' && v.status !== 'unknown')) {
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
                    ? `<a class="lib-name" href="${esc(url)}" target="_blank" rel="noopener" title="فتح صفحة المكتبة">${esc(l.name)}</a>`
                    : `<span class="lib-name">${esc(l.name)}</span>`;
                // Supply-chain safety net (Vuln API v0.6.0): warn when the fix
                // was published recently — compromised packages have stayed
                // live for hours-to-days before discovery (event-stream, nx).
                const freshFix = cls === 'danger' && v && typeof v.daysSinceFix === 'number' && v.daysSinceFix < 7
                    ? `<span class="lib-fresh" title="الفيكس صدر قبل ${v.daysSinceFix} يوم — انتظر قبل الترقية">⏳ منذ ${v.daysSinceFix} يوم</span>` : '';
                return `<div class="deps-row ${cls}">
                    ${devTag}
                    ${nameEl}
                    <span class="lib-ver">${esc(l.version)}</span>
                    ${arrow}
                    ${freshFix}
                </div>`;
            }).join('');
        }

        function patchFileExts(p) {
            const container = document.getElementById('hdr-exts');
            if (!container) return;
            const newExts = Object.entries(p.files || {}).sort((a,b) => b[1]-a[1]);
            const existing = {};
            container.querySelectorAll('[data-ext]').forEach(el => { existing[el.dataset.ext] = el; });

            const newExtKeys = new Set(newExts.map(([ext]) => ext));

            // Remove gone extensions
            for (const ext in existing) {
                if (!newExtKeys.has(ext)) {
                    existing[ext].style.transition = 'opacity 0.3s, transform 0.3s';
                    existing[ext].style.opacity = '0';
                    existing[ext].style.transform = 'scale(0.7)';
                    setTimeout(() => existing[ext].remove(), 300);
                }
            }

            // Add or update
            for (const [ext, n] of newExts) {
                if (existing[ext]) {
                    // Update count if changed
                    const numEl = existing[ext].querySelector('.ext-num');
                    if (numEl && numEl.textContent !== String(n)) {
                        numEl.textContent = n;
                        numEl.classList.remove('val-flash');
                        void numEl.offsetWidth;
                        numEl.classList.add('val-flash');
                    }
                } else {
                    // New extension badge
                    const span = document.createElement('span');
                    span.dataset.ext = ext;
                    span.className = 'badge-new';
                    span.style.cssText = "font-size:0.7em;padding:1px 6px;border-radius:3px;background:var(--bg3);font-family:'Cascadia Code',Consolas,monospace;color:var(--text2)";
                    span.innerHTML = `<span style="color:var(--emerald)">.${esc(ext)}</span> <span class="ext-num" style="color:var(--pink)">${n}</span>`;
                    container.appendChild(span);
                }
            }
        }

        function patchHeader() {
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
                const hasAbout = !!(p.about && p.about.trim());
                const aboutBtn = document.getElementById('hdr-about-btn');
                if (aboutBtn) {
                    const ab = aboutBtnAttrs(hasAbout);
                    if (aboutBtn.className !== ab.cls) aboutBtn.className = ab.cls;
                    aboutBtn.title = ab.title;
                }
                descWrap.style.display = (newDesc || hasAbout) ? '' : 'none';
            }

            // Stats
            patch(document.getElementById('hdr-files'), p.totalFiles);
            patch(document.getElementById('hdr-libs'), p.libraries.length);
            patch(document.getElementById('hdr-dirs'), (p.directories || []).length);
            patch(document.getElementById('hdr-tags'), tags.length);

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
                langEl.style.background = color + '18';
                langEl.style.color = color;
                langEl.classList.remove('val-flash'); void langEl.offsetWidth; langEl.classList.add('val-flash');
            }

            // Runtime
            const rtEl = document.getElementById('hdr-runtime');
            if (rtEl && p.runtime) {
                const rtText = (p.runtime.name || '') + (p.runtime.version ? ' ' + p.runtime.version : '') + (p.runtime.edition ? ' · ' + p.runtime.edition : '');
                if (rtEl.textContent !== rtText) { patch(rtEl, rtText); }
            }

            // Libraries
            patchLibraries(p);

            // File extensions — surgical per-badge
            patchFileExts(p);

            // Active Claude sessions + background processes
            patchSessions(p.name);

            // Stats popup (files, libs, dirs, tags, exts)
            patchStatsButton(p, tags);
        }

        async function patchSessions(projectName) {
            const el = document.getElementById('hdr-sessions');
            if (!el) return;
            try {
                const [sRes, pRes] = await Promise.all([
                    fetch(`/api/sessions?project=${encodeURIComponent(projectName)}`).then(r => r.json()),
                    fetch(`/api/processes?project=${encodeURIComponent(projectName)}`).then(r => r.json()),
                ]);
                const sessions = sRes.items || [];
                const orphans = pRes.orphans || 0;
                const active = pRes.active || 0;
                if (sessions.length === 0 && orphans === 0 && active === 0) {
                    el.style.display = 'none';
                    return;
                }
                const pids = sessions.map(s => s.pid).join(', ');
                let text = sessions.length ? `PID ${pids} claude.exe` : '';
                if (active) text += ` · ${active} عملية خلفية`;
                if (orphans) text += ` · ⚠️ ${orphans} معلّقة`;
                const newBg = orphans ? '#2e0d0d' : '#0d2e1f';
                const newColor = orphans ? '#ef476f' : '#06d6a0';
                if (el.textContent !== text) {
                    el.textContent = text;
                    el.style.background = newBg;
                    el.style.color = newColor;
                    el.classList.remove('val-flash'); void el.offsetWidth; el.classList.add('val-flash');
                }
                el.style.display = '';
            } catch {
                el.style.display = 'none';
            }
        }

        async function openSessionsPanel(projectName) {
            const [sRes, pRes] = await Promise.all([
                fetch(`/api/sessions?project=${encodeURIComponent(projectName)}`).then(r => r.json()),
                fetch(`/api/processes?project=${encodeURIComponent(projectName)}`).then(r => r.json()),
            ]);
            const sessions = sRes.items || [];
            const procs = pRes.items || [];

            const sessionRows = sessions.map(s => `
                <div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg2)">
                    <div style="font-weight:600;color:#06d6a0">PID ${s.pid} · claude.exe</div>
                    <div style="font-size:0.75em;color:var(--text2);margin-top:3px">
                        session: ${esc((s.sessionId || '').slice(0, 8))}... · بدأت: ${new Date(s.startedAt).toLocaleString('ar')}
                    </div>
                </div>
            `).join('') || '<div style="color:var(--text2);font-size:0.85em">لا توجد جلسات نشطة</div>';

            const activeProcs = procs.filter(p => !p.orphaned);
            const orphanProcs = procs.filter(p => p.orphaned);

            const procRow = (p) => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;background:var(--bg2);font-size:0.8em">
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;color:${p.orphaned ? '#ef476f' : '#ffd166'}">PID ${p.pid} · ${esc(p.name || '')}</div>
                        <div style="font-size:0.9em;color:var(--text2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.command || '')}">${esc((p.command || '').slice(0, 120))}</div>
                    </div>
                    <button data-action="kill-pid" data-pid="${p.pid}" data-project="${esc(projectName)}" style="padding:4px 10px;background:#ef476f;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.85em">قتل</button>
                </div>
            `;

            const modal = document.getElementById('sessionsModal') || (() => {
                const m = document.createElement('div');
                m.id = 'sessionsModal';
                m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
                document.body.appendChild(m);
                return m;
            })();

            modal.innerHTML = `
                <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;max-width:800px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;direction:rtl">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
                        <h3 style="margin:0">جلسات وعمليات: ${esc(projectName)}</h3>
                        <button data-action="close-sessions-modal" style="background:none;border:none;color:var(--text);font-size:1.5em;cursor:pointer">×</button>
                    </div>
                    <h4 style="margin:12px 0 8px;color:#06d6a0">🟢 جلسات Claude نشطة (${sessions.length})</h4>
                    ${sessionRows}
                    <h4 style="margin:15px 0 8px;color:#ffd166">⚙️ عمليات خلفية نشطة (${activeProcs.length})</h4>
                    ${activeProcs.length ? activeProcs.map(procRow).join('') : '<div style="color:var(--text2);font-size:0.85em">لا توجد</div>'}
                    ${orphanProcs.length ? `<h4 style="margin:15px 0 8px;color:#ef476f">⚠️ عمليات معلّقة من جلسات مغلقة (${orphanProcs.length})</h4>${orphanProcs.map(procRow).join('')}` : ''}
                    <div style="margin-top:15px;text-align:left">
                        <button data-action="refresh-processes" data-project="${esc(projectName)}" style="padding:6px 14px;background:var(--border);color:var(--text);border:none;border-radius:4px;cursor:pointer">تحديث</button>
                    </div>
                </div>
            `;
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        }

        async function killPid(pid, projectName) {
            if (!confirm(`قتل العملية ${pid}؟`)) return;
            // Visible failure on network error instead of a silent unhandled
            // rejection (R3 P7), matching the alert pattern used elsewhere.
            try {
                const r = await fetch(`${API}/api/kill-pid/${pid}`, { method: 'POST' }).then(r => r.json());
                if (r.ok) openSessionsPanel(projectName);
                else alert('فشل: ' + (r.error || 'غير معروف'));
            } catch (e) {
                alert('فشل الاتصال بالخادم: ' + (e?.message || e));
            }
        }

        async function refreshProcesses(projectName) {
            try {
                await fetch(`${API}/api/processes/refresh`, { method: 'POST' });
                openSessionsPanel(projectName);
            } catch (e) {
                alert('فشل تحديث العمليات: ' + (e?.message || e));
            }
        }

        function updateSidebarStats() {
            const el = document.getElementById('centerStats');
            if (!activeProject) { el.style.display = 'none'; return; }
            const tags = getProjectTags();
            const builts = tags.filter(t => t.tag === "built").length;
            const todos = tags.filter(t => t.tag === "todo");
            const dones = new Set(tags.filter(t => t.tag === "done").map(d => normTag(d.content)));
            const dropped = new Set(tags.filter(t => t.tag === "dropped").map(d => normTag(d.content)));
            const bugFounds = tags.filter(t => t.tag === "bug found");
            const bugFixes = tags.filter(t => t.tag === "bug fix");
            const plans = (data.plans || []).filter(p => p.project === activeProject);

            const doneNums = closedNumSet(tags, ["done", "dropped"]);
            let openTodos = 0;
            for (const t of todos) {
                // Atomic todos: don't split on commas — a prose comma would fragment the item, and the fragment never matches the whole-string done/dropped, leaving it open forever.
                for (const item of [t.content.trim()].filter(Boolean)) {
                    const low = normTag(item);
                    const closedByNum = typeof t.num === 'number' && doneNums.has(t.num);
                    if (!dones.has(low) && !dropped.has(low) && !closedByNum) openTodos++;
                }
            }

            let totalSteps = 0, doneSteps = 0;
            for (const plan of plans) { totalSteps += plan.steps.length; doneSteps += plan.steps.filter(s => s.completed).length; }
            totalSteps += todos.length; doneSteps += (todos.length - openTodos);

            const bugFixNums = closedNumSet(tags, ["bug fix"]);
            const openBugs = bugFounds.filter(b => !(typeof b.num === 'number' && bugFixNums.has(b.num)) && !bugFixes.some(f => fuzzy(f.content, b.content))).length;
            const secTags = tags.filter(t => SEC_OPEN_TAGS.has(t.tag));
            const secFixes = tags.filter(t => t.tag === "security fix");
            const secFixNums = closedNumSet(tags, ["security fix"]);
            const openSec = secTags.filter(s => !(typeof s.num === 'number' && secFixNums.has(s.num)) && !secFixes.some(f => fuzzy(f.content, s.content))).length;
            const outdatedCount = tags.filter(t => t.tag === "outdated").length;

            // New separate card: 5 stat numbers
            const numbersEl = document.getElementById('statsNumbers');
            if (numbersEl) {
                numbersEl.innerHTML = `
                    <div><div class="ss-val" style="color:var(--emerald)">${builts}</div><div class="ss-label">بناء</div></div>
                    <div><div class="ss-val" style="color:var(--gold)">${openTodos}</div><div class="ss-label">مهام</div></div>
                    <div><div class="ss-val" style="color:${openBugs > 0 ? 'var(--pink)' : 'var(--emerald)'}">${openBugs}</div><div class="ss-label">خلل</div></div>
                    <div><div class="ss-val" style="color:${openSec > 0 ? 'var(--pink)' : 'var(--emerald)'}">${openSec}</div><div class="ss-label">أمني</div></div>
                    <div><div class="ss-val" style="color:${outdatedCount > 0 ? 'var(--gold)' : 'var(--emerald)'}">${outdatedCount}</div><div class="ss-label">قديمة</div></div>
                `;
                numbersEl.style.display = 'flex';
            }

            // Existing capsule: bars only
            const bars = [];
            if (totalSteps > 0) {
                const pct = Math.min(100, Math.round((doneSteps / totalSteps) * 100));
                const tip = `تنفيذ الخطط والمهام: ${doneSteps}/${totalSteps} (${pct}%)`;
                bars.push(`<div class="progress-track" title="${tip}"><div class="progress-fill" style="width:${pct}%;background:var(--emerald)"></div></div>`);
            }
            if (bugFounds.length > 0) {
                const bugFixNums = closedNumSet(tags, ["bug fix"]);
                const fixedCount = bugFounds.filter(b => (typeof b.num === 'number' && bugFixNums.has(b.num)) || bugFixes.some(f => fuzzy(f.content, b.content))).length;
                const pct = Math.min(100, Math.round((fixedCount / bugFounds.length) * 100));
                const tip = `إصلاح الأخطاء المكتشفة: ${fixedCount}/${bugFounds.length} (${pct}%)`;
                bars.push(`<div class="progress-track" title="${tip}"><div class="progress-fill" style="width:${pct}%;background:var(--pink)"></div></div>`);
            }
            if (bars.length > 0) {
                el.innerHTML = `<div class="center-stats-bars">${bars.join('')}</div>`;
                el.style.display = 'flex';
            } else {
                el.innerHTML = '';
                el.style.display = 'none';
            }
        }

        // Per-plan expanded state (planId → bool). Most-recent plan defaults
        // to expanded; toggled by clicking the header. Survives re-renders so
        // a live tags update doesn't slam every plan shut on the user.
        const planExpanded = {};
        let showCompletedPlans = false;

        function renderActivePlanCard(project) {
            const el = document.getElementById('cardActivePlan');
            if (!el) return;
            const allPlans = (data.plans || [])
                .filter(p => p.project === project && p.steps && p.steps.length > 0)
                .sort((a, b) => +new Date(b.updatedAt || b.timestamp) - +new Date(a.updatedAt || a.timestamp));

            const isComplete = p => p.steps.every(s => s.completed);
            const completedPlans = allPlans.filter(isComplete);
            const projectPlans = showCompletedPlans ? allPlans : allPlans.filter(p => !isComplete(p));

            const header = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">الخطط النشطة${projectPlans.length > 1 ? ` (${projectPlans.length})` : ''}</div>`;

            if (projectPlans.length === 0 && completedPlans.length === 0) {
                updateCard('cardActivePlan', header + `<div style="font-size:0.7em;color:var(--text2)">لا توجد خطط نشطة. أرسل <code style="color:var(--gold);font-family:'Cascadia Code',monospace">-(doc:plan) name</code> لبدء واحدة.</div>`);
                return;
            }

            // Default the newest plan open if no state yet.
            if (projectPlans.length > 0 && planExpanded[projectPlans[0].id] === undefined) {
                planExpanded[projectPlans[0].id] = true;
            }

            const sections = projectPlans.map((plan) => {
                const done = plan.steps.filter(s => s.completed).length;
                const total = plan.steps.length;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const expanded = !!planExpanded[plan.id];
                const arrow = expanded ? '▾' : '◂';

                const sortedSteps = [
                    ...plan.steps.filter(s => !s.completed),
                    ...plan.steps.filter(s => s.completed),
                ];
                const stepRows = expanded ? sortedSteps.map(s => {
                    const numHtml = typeof s.num === "number"
                        ? `<span style="font-size:0.85em;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;flex-shrink:0;margin-top:2px">#${s.num}</span>`
                        : '';
                    return `
                    <div style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:0.7em;${s.completed ? 'opacity:0.55' : ''}">
                        <span style="flex-shrink:0;width:11px;height:11px;border-radius:2px;margin-top:3px;${s.completed ? 'background:var(--emerald)' : 'border:1.5px solid var(--border)'}"></span>
                        ${numHtml}
                        <span style="flex:1;${s.completed ? 'text-decoration:line-through;color:var(--text2)' : ''}">${esc(s.text)}</span>
                    </div>`;
                }).join("") : '';

                return `
                <div data-plan-id="${esc(plan.id)}" style="margin-bottom:8px;border:1px solid var(--border);border-radius:6px;overflow:hidden">
                    <div data-action="toggle-plan" data-plan-id="${esc(plan.id)}" style="display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;background:var(--bg2);user-select:none">
                        <span style="font-size:0.7em;color:var(--text2);width:10px">${arrow}</span>
                        <span style="flex:1;font-size:0.78em;color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(plan.title)}">${esc(plan.title)}</span>
                        <span style="color:var(--text2);font-weight:400;font-size:0.7em;flex-shrink:0">${done}/${total}</span>
                        <button data-action="hide-plan" data-plan-id="${esc(plan.id)}" data-plan-title="${esc(plan.title)}" title="إخفاء من الداشبورد (الملفات تبقى)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:0.85em;padding:0 4px;flex-shrink:0">👁️</button>
                    </div>
                    <div style="height:3px;background:var(--bg3)"><div style="width:${pct}%;height:100%;background:var(--emerald);transition:width 0.3s"></div></div>
                    ${expanded ? `<div style="padding:6px 8px;max-height:200px;overflow-y:auto">${stepRows}</div>` : ''}
                </div>`;
            }).join("");

            const completedToggle = completedPlans.length > 0
                ? `<div data-action="toggle-completed-plans" style="margin-top:6px;padding:5px 8px;font-size:0.7em;color:var(--text2);cursor:pointer;border-top:1px solid var(--border);user-select:none;text-align:center">
                     ${showCompletedPlans ? '◂ إخفاء' : '▾ إظهار'} ${completedPlans.length} خطة مكتملة
                   </div>`
                : '';

            updateCard('cardActivePlan',
                header
                + `<div style="overflow-y:auto;flex:1;min-height:0">${sections}</div>`
                + completedToggle
            );
        }

        async function killServer(btn) {
            if (!confirm("إيقاف السيرفر؟\nإذا كان مُشغَّلاً بـ`bun --watch` فسيعود تلقائياً، وإلا ستحتاج تشغيله يدوياً.")) return;
            btn.classList.add("loading");
            btn.textContent = "...جاري الإيقاف";
            try {
                await fetch(`${API}/api/server/stop`, { method: "POST", headers: { "Content-Type": "application/json" } });
            } catch { /* expected — server died mid-response */ }
            setTimeout(() => location.reload(), 1500);
        }

        async function hidePlan(planId, planTitle) {
            if (!confirm(`إخفاء الخطة "${planTitle}" من الداشبورد؟\nالملفات (.md/.html) تبقى — يمكن استعادتها بإعادة إرسال -(doc:plan) بنفس الاسم.`)) return;
            try {
                const res = await fetch(`${API}/api/plan/${encodeURIComponent(planId)}`, { method: "DELETE" });
                if (res.ok) {
                    data.plans = (data.plans || []).filter(p => p.id !== planId);
                    delete planExpanded[planId];
                    renderActivePlanCard(activeProject);
                } else {
                    alert("فشل الإخفاء");
                }
            } catch (e) {
                alert("خطأ: " + e.message);
            }
        }

        async function renderChangesCard(project) {
            const el = document.getElementById('cardChanges');
            if (!el) return;
            el.innerHTML = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">التغييرات في الكود</div><div id="changesList" style="overflow-y:auto;flex:1;min-height:0;direction:ltr;font-size:0.72em">جاري التحميل…</div>`;
            try {
                const r = await fetch(`${API}/api/changes?project=${encodeURIComponent(project)}&n=30`);
                const j = await r.json();
                const items = j.items || [];
                const list = document.getElementById('changesList');
                if (!list) return;
                if (!items.length) {
                    list.innerHTML = `<div style="color:var(--text2);font-size:0.95em;text-align:center;padding-top:12px">لا توجد تعديلات بعد</div>`;
                    return;
                }
                list.innerHTML = items.map(it => {
                    const fname = (it.file_path || '').replace(/\\/g, '/').split('/').pop() || '?';
                    const dir = (it.file_path || '').replace(/\\/g, '/').split('/').slice(-3, -1).join('/');
                    const time = timeStr(it.timestamp);
                    const adds = it.lines_added > 0 ? `<span style="color:var(--emerald)">+${it.lines_added}</span>` : '';
                    const dels = it.lines_removed > 0 ? `<span style="color:var(--pink)">−${it.lines_removed}</span>` : '';
                    const stale = it.has_full_content ? '' : `<span title="المحتوى مُجرَّد بعد retention" style="color:var(--text2);font-size:0.85em">·archived</span>`;
                    const action = it.action === 'create' ? 'create' : 'edit';
                    return `<div class="ch-row" data-id="${esc(it.id)}" style="padding:6px 8px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;gap:8px;align-items:center;justify-content:space-between">
                        <div style="min-width:0;flex:1;display:flex;flex-direction:column;gap:2px">
                            <div style="display:flex;gap:6px;align-items:baseline">
                                <span style="font-family:'Cascadia Code',Consolas,monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(fname)}</span>
                                <span style="color:var(--text2);font-size:0.85em">${esc(action)}</span>
                                ${stale}
                            </div>
                            ${dir ? `<div style="color:var(--text2);font-size:0.85em;font-family:'Cascadia Code',Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dir)}</div>` : ''}
                        </div>
                        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
                            ${adds}${dels}
                            <span style="color:var(--text2);font-size:0.85em">${esc(time)}</span>
                        </div>
                    </div>`;
                }).join('');
                list.querySelectorAll('.ch-row').forEach(row => {
                    row.addEventListener('click', () => openDiffModal(row.dataset.id));
                });
            } catch (e) {
                const list = document.getElementById('changesList');
                if (list) list.innerHTML = `<div style="color:var(--pink)">فشل تحميل التغييرات: ${esc(String(e.message || e))}</div>`;
            }
        }

        async function openDiffModal(id) {
            try {
                const r = await fetch(`${API}/api/changes/by-id/${encodeURIComponent(id)}`);
                if (!r.ok) return;
                const e = await r.json();
                const oldS = e.old_string || '';
                const newS = e.new_string || e.content || '';
                const isCreate = !e.old_string && (e.content || e.new_string);
                const diffHtml = isCreate ? renderUnifiedDiff('', newS) : renderUnifiedDiff(oldS, newS);
                const fname = (e.file_path || '').replace(/\\/g, '/').split('/').pop();
                const overlay = document.createElement('div');
                overlay.id = 'diffOverlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:30px';
                overlay.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:100%;max-width:1100px;height:100%;display:flex;flex-direction:column;direction:ltr">
                    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;direction:rtl">
                        <span style="font-family:'Cascadia Code',Consolas,monospace;color:var(--gold);font-size:0.9em">${esc(fname)}</span>
                        <span style="color:var(--text2);font-size:0.75em">${esc(e.file_path || '')}</span>
                        <span style="margin-right:auto;color:var(--text2);font-size:0.75em">${esc(timeStr(e.timestamp))}</span>
                        <button id="diffClose" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:inherit">إغلاق</button>
                    </div>
                    <div style="overflow:auto;flex:1;padding:0;font-family:'Cascadia Code',Consolas,monospace;font-size:0.78em;line-height:1.55;direction:ltr">${diffHtml}</div>
                </div>`;
                document.body.appendChild(overlay);
                const close = () => overlay.remove();
                overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
                overlay.querySelector('#diffClose').addEventListener('click', close);
                document.addEventListener('keydown', function once(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', once); } });
            } catch {}
        }

        // Compute a unified-style line diff. Trims common prefix/suffix lines,
        // then shows the differing block as removed (-) then added (+).
        function renderUnifiedDiff(oldStr, newStr) {
            const oldLines = oldStr.split('\n');
            const newLines = newStr.split('\n');
            let prefix = 0;
            while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
            let suffix = 0;
            while (
                suffix < (oldLines.length - prefix) &&
                suffix < (newLines.length - prefix) &&
                oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
            ) suffix++;
            const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
            const newMid = newLines.slice(prefix, newLines.length - suffix);
            const ctxBefore = oldLines.slice(Math.max(0, prefix - 3), prefix);
            const ctxAfter = oldLines.slice(oldLines.length - suffix, Math.min(oldLines.length, oldLines.length - suffix + 3));
            const row = (sym, color, bg, text, lineNo) => `<div style="display:flex;background:${bg};color:${color};white-space:pre">
                <span style="width:50px;text-align:right;padding:0 8px;color:var(--text2);user-select:none;flex-shrink:0">${lineNo}</span>
                <span style="width:14px;text-align:center;flex-shrink:0">${sym}</span>
                <span style="flex:1;padding:0 8px">${esc(text)}</span>
            </div>`;
            const out = [];
            let oN = Math.max(0, prefix - ctxBefore.length) + 1;
            for (const l of ctxBefore) { out.push(row(' ', 'var(--text2)', 'transparent', l, oN++)); }
            let oNum = prefix + 1;
            for (const l of oldMid) out.push(row('-', '#f88', 'rgba(255,80,80,0.08)', l, oNum++));
            let nNum = prefix + 1;
            for (const l of newMid) out.push(row('+', '#9f9', 'rgba(80,255,150,0.08)', l, nNum++));
            let aN = oldLines.length - suffix + 1;
            for (const l of ctxAfter) { out.push(row(' ', 'var(--text2)', 'transparent', l, aN++)); }
            if (out.length === 0) return `<div style="padding:20px;color:var(--text2);text-align:center">لا فرق</div>`;
            return out.join('');
        }

        function renderProject() {
            const p = data.projects[activeProject];
            if (!p) return;

            const tags = getProjectTags();

            // Build header structure once, then patch
            if (!headerBuilt || document.getElementById('hdr-name')?.textContent !== p.name) {
                buildHeaderOnce(p, tags);
            } else {
                patchHeader();
            }

            // Render all panels
            renderFiles(p, tags);
            updateSidebarStats();
        }

        // ===== Tab 1: Summary =====

        // ===== File Tree Renderer =====

        const extIcons = {
            ts: "#3178c6", js: "#f7df1e", py: "#3776ab", rs: "#dea584",
            go: "#00add8", html: "#e34f26", css: "#1572b6", json: "#ffd166",
            md: "#777777", sh: "#4eaa25", toml: "#9c4121", yaml: "#cb171e",
            yml: "#cb171e", sql: "#336791", vue: "#42b883", svelte: "#ff3e00",
        };

        let ctxTargetPath = '';
        let ctxTargetFile = '';

        function renderTreeNodes(nodes, basePath) {
            let html = '';
            for (const node of nodes) {
                if (node.type === "dir") {
                    const count = countFiles(node);
                    const fullPath = basePath + '/' + node.name;
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
            document.querySelectorAll('.ctx-selected').forEach(el => el.classList.remove('ctx-selected'));
        });
        document.addEventListener('contextmenu', (e) => {
            const tree = e.target.closest('.tree');
            if (!tree) return;

            const dir = e.target.closest('.tree-dir');
            const file = e.target.closest('.tree-file');

            if (dir) {
                e.preventDefault();
                ctxTargetPath = dir.getAttribute('data-path') || '';
                ctxTargetFile = '';
                document.getElementById('ctxIgnoreLabel').textContent = 'تجاهل هذا المجلد';
                document.getElementById('ctxOpenLabel').style.display = 'none';
            } else if (file) {
                e.preventDefault();
                ctxTargetPath = file.getAttribute('data-dir') || '';
                ctxTargetFile = file.getAttribute('data-name') || '';
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
            document.querySelectorAll('.ctx-selected').forEach(el => el.classList.remove('ctx-selected'));
            (dir || file).classList.add('ctx-selected');

            const menu = document.getElementById('ctxMenu');
            menu.style.display = 'block';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';
        });

        async function ignoreTarget() {
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
                fullRenderNeeded = true;
                cachedTree = null;
                fetchData(true);
            } catch {}
        }

        // Open the right-clicked file's content in a new browser tab. The server
        // serves it as text/plain + nosniff, so even .html/.svg files just show
        // as text and never execute.
        function openTargetFile() {
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
            const file = e.target.closest && e.target.closest('.tree-file');
            if (!file) return;
            clearTimeout(filePopupHideTimer);
            clearTimeout(filePopupTimer);
            filePopupTimer = setTimeout(() => showFilePopup(file), 280);
        });
        document.addEventListener('mouseout', (e) => {
            const file = e.target.closest && e.target.closest('.tree-file');
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
            popup.style.left = Math.max(pad, x) + 'px';
            popup.style.top = Math.max(pad, y) + 'px';
        }

        function countFiles(node) {
            if (node.type === "file") return 1;
            let c = 0;
            if (node.children) for (const child of node.children) c += countFiles(child);
            return c;
        }

        // ===== Tab 2: Architecture =====

        // ===== Main View =====

        let cachedTree = null;

        async function renderFiles(project, tags) {
            const el = document.getElementById("panel-files");

            // Build tags HTML (only tags)
            let tagsHtml = '';
            if (tags && tags.length > 0) {
                const filtered = logFilter === "all" ? tags : tags.filter(t => filterGroups[logFilter]?.includes(t.tag));

                tagsHtml += '<div class="log-filters">';
                for (const [key, label] of Object.entries(filterLabels)) {
                    const count = key === "all" ? tags.length : tags.filter(t => filterGroups[key].includes(t.tag)).length;
                    if (key !== "all" && count === 0) continue;
                    tagsHtml += `<button class="log-filter${logFilter === key ? ' active' : ''}" data-action="set-log-filter" data-key="${esc(key)}">${esc(label)} <span class="tab-badge tab-badge-default">${count}</span></button>`;
                }
                tagsHtml += '</div>';

                let inner = '';
                const projectPlans = (data.plans || []).filter(p => p.project === activeProject);
                for (const t of filtered) {
                    const tc = tagClass(t.tag);
                    const display = resolveTagDisplay(t, tags, projectPlans);
                    const sec = t.tag === 'security'
                        ? ` data-action="show-vulns-tag" data-project="${esc(activeProject)}" data-content="${esc(t.content)}" style="cursor:pointer;text-decoration:underline dotted"`
                        : '';
                    const ttl = t.tag === 'security' ? `${display} — اضغط لتفاصيل الثغرات` : display;
                    inner += `<div class="log-item${t.breaking ? ' is-breaking' : ''}">
                        <div class="log-bar bar-${tc}"></div>
                        <span class="log-tag tag-${tc}">${esc(tagLabels[t.tag] || t.tag)}</span>
                        <span class="log-content"${sec} title="${esc(ttl)}">${esc(tagSummary(display))}</span>
                        <span class="log-time">${timeStr(t.timestamp)}</span>
                    </div>`;
                }
                if (inner) tagsHtml += `<div style="overflow-y:auto;flex:1">${inner}</div>`;
            }

            // Build events HTML (raw hooks)
            // Build todos + security HTML — shared builders, identical to the
            // surgical poll/WS path so neither card can diverge on refresh.
            const todosCardHtml = buildTodosHtml(tags);
            let secHtml = buildSecurityHtml(tags, project);

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
            document.getElementById('cardTags').innerHTML = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">التاقات</div><div style="overflow-y:auto;flex:1;min-height:0">${tagsHtml || '<div style="color:var(--text2);font-size:0.7em">لا توجد تاقات</div>'}</div>`;
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
                    cachedTree = tree;
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

        function buildDocsHtml(project) {
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
        function buildEventsHtml(allEvents, project) {
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

        function buildTodosHtml(tags) {
            const doneTexts = new Set(tags.filter(t => t.tag === "done").map(d => normTag(d.content)));
            const droppedTexts = new Set(tags.filter(t => t.tag === "dropped").map(d => normTag(d.content)));
            const doneNums = closedNumSet(tags, ["done"]);
            const droppedNums = closedNumSet(tags, ["dropped"]);
            const openTodos = [], closedTodos = [];
            for (const t of tags.filter(t => t.tag === "todo")) {
                const item = (t.content || "").trim();
                if (!item) continue;
                const low = normTag(item);
                const num = typeof t.num === "number" ? t.num : null;
                if (droppedTexts.has(low) || isDoneFuzzy(low, droppedTexts) || (num !== null && droppedNums.has(num))) continue;
                const entry = { text: item, num };
                if (isDoneFuzzy(low, doneTexts) || (num !== null && doneNums.has(num))) closedTodos.push(entry);
                else openTodos.push(entry);
            }
            const numBadge = (n) => n != null
                ? `<span style="font-size:0.85em;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;flex-shrink:0">#${n}</span>`
                : '';
            const notes = tags.filter(t => t.tag === "note").slice(0, 5);
            let inner = '';
            for (const t of openTodos) {
                inner += `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em;direction:rtl">
                    <span style="width:10px;height:10px;border:1.5px solid var(--border);border-radius:2px;flex-shrink:0"></span>
                    ${numBadge(t.num)}
                    <span style="flex:1">${esc(t.text)}</span>
                </div>`;
            }
            for (const t of closedTodos) {
                inner += `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em;direction:rtl;opacity:0.5">
                    <span style="width:10px;height:10px;background:var(--emerald);border-radius:2px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:0.6em;color:var(--bg)">&#10003;</span>
                    ${numBadge(t.num)}
                    <span style="flex:1;text-decoration:line-through;color:var(--text2)">${esc(t.text)}</span>
                </div>`;
            }
            if (notes.length) {
                inner += '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:4px">';
                for (const n of notes) {
                    inner += `<div style="font-size:0.7em;color:var(--text2);padding:2px 0;direction:rtl">📝 ${esc(n.content)}</div>`;
                }
                inner += '</div>';
            }
            return `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">المهام</div><div style="overflow-y:auto;flex:1;min-height:0">${inner || '<div style="font-size:0.7em;color:var(--text2)">لا توجد مهام</div>'}</div>`;
        }

        function buildSecurityHtml(tags, project) {
            // Pull vuln dates by package name (parsed from tag content like
            // "sysinfo@0.38.4 — احدث: 0.39.1"). Used to show release dates +
            // the "wait before upgrading" supply-chain warning (Vuln v0.6.0).
            const vulnResults = (project && project.vulnResults) || {};
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
                const url = registryUrl(project && project.language, parsed.name);
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
            const securityFixes = tags.filter(t => t.tag === "security fix");
            const bugFounds = tags.filter(t => t.tag === "bug found");
            const bugFixes = tags.filter(t => t.tag === "bug fix");
            const outdatedTags = tags.filter(t => t.tag === "outdated");

            const secFixNums = closedNumSet(tags, ["security fix"]);
            const bugFixNums = closedNumSet(tags, ["bug fix"]);
            const secClosed = s => (typeof s.num === 'number' && secFixNums.has(s.num)) || securityFixes.some(f => fuzzy(f.content, s.content));
            const bugClosed = b => (typeof b.num === 'number' && bugFixNums.has(b.num)) || bugFixes.some(f => fuzzy(f.content, b.content));
            const openSec = securityTags.filter(s => !secClosed(s));
            const closedSec = securityTags.filter(secClosed);
            const openBugs = bugFounds.filter(b => !bugClosed(b));
            const closedBugs = bugFounds.filter(bugClosed);

            const totalIssues = securityTags.length + bugFounds.length;
            const totalFixed = closedSec.length + closedBugs.length;
            const totalOpen = openSec.length + openBugs.length;

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
                    const stitle = clickable ? `${s.content} — اضغط لتفاصيل الثغرات` : s.content;
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
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pink)" title="${esc(b.content)}">${esc(b.content)}</span>
                        ${delBtn(b.id, 'bug')}
                    </div>`;
                }
            }
            if (closedSec.length > 0) {
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px">ثغرات مُصلحة</div>';
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
            if (outdatedTags.length > 0) {
                // Supply-chain safety: when latest is very fresh (< 7 days),
                // libRow renders the gold ⏳ warning. Recent npm/crates
                // compromises (event-stream, nx, ua-parser-js) stayed live
                // for hours-to-days before discovery — rapid auto-upgrades
                // were the attack vector.
                h += '<div style="font-size:0.7em;color:var(--text2);margin:8px 0 4px;border-top:1px solid var(--border);padding-top:8px">مكتبات قديمة</div>';
                for (const o of outdatedTags) {
                    h += libRow(o.content, 'latest', { accent: 'var(--gold)', icon: '&#8635;' });
                }
            }
            return h;
        }

        // ===== Filters =====



        function setLogFilter(filter) {
            logFilter = filter;
            const p = data.projects[activeProject];
            if (p) renderFiles(p, getProjectTags());
        }

        // ===== Tab 5: Project =====

        // ===== Injection Panel =====

        let injState = {
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
            claudeMd:         { label: "CLAUDE.md",        sub: "كتابة ملخص المشروع في ملف CLAUDE.md (قيد التطوير)", dynamic: false },
            contextMd:        { label: ".devlog/context.md", sub: "كتابة سياق إضافي في ملف (قيد التطوير)",       dynamic: false },
            standardsEnforce: { label: "إجبار المعايير",   sub: "يمنع كتابة الكود حتى يسحب كلود معايير المشروع. أوقفه للمشاريع المطبَّقة أصلاً (السحب اليدوي يبقى متاحاً)." },
        };

        async function openInjectionPanel(project) {
            injState.project = project;
            injState.scope = "global";
            document.getElementById('injProjectName').textContent = project;
            document.getElementById('injModal').classList.add('open');
            await loadInjectionConfig();
            await loadInjectionHistory();
            renderInjectionPanel();
        }

        function closeInjectionPanel() {
            document.getElementById('injModal').classList.remove('open');
        }

        // ===== Standards Viewer (read-only catalog browser) =====
        const STD_AXIS_ORDER = ["languages", "runtimes", "frameworks", "platforms", "app-types", "cross-cutting", "(root)"];

        async function openStandardsPanel(project) {
            document.getElementById('stdProjectName').textContent = project || '';
            document.getElementById('stdModal').classList.add('open');
            const body = document.getElementById('stdBody');
            body.innerHTML = '<div class="inj-empty">جارٍ التحميل…</div>';
            const cwd = (data.projects && data.projects[project] && data.projects[project].path) || '';
            try {
                const res = await fetch(`${API}/api/standards?cwd=${encodeURIComponent(cwd)}`);
                body.innerHTML = renderStandards(await res.json());
            } catch (e) {
                body.innerHTML = '<div class="inj-empty">فشل تحميل المعايير</div>';
            }
        }

        function closeStandardsPanel() {
            document.getElementById('stdModal').classList.remove('open');
        }

        function renderStandards(j) {
            const cats = j.categories || [];
            if (!cats.length) return '<div class="inj-empty">الكتالوج فارغ — أضف ملفات .md في ~/.claude/standards/</div>';
            const c = j.counts || {};
            const byAxis = {};
            for (const cat of cats) (byAxis[cat.axis] = byAxis[cat.axis] || []).push(cat);
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
                    if (cat.rules && cat.rules.length) {
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

            const dynamicRows = ["sessionStart","userPromptSubmit","preToolUseRead","outdatedLibs","describeNudge"].map(k => {
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

        async function switchInjScope(scope) {
            injState.scope = scope;
            await loadInjectionConfig();
            renderInjectionPanel();
        }

        async function toggleInjection(key, val) {
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

        async function clearInjectionOverride() {
            await fetch(`${API}/api/injection/config?project=${encodeURIComponent(injState.project)}`, { method: "DELETE" });
            await loadInjectionConfig();
            renderInjectionPanel();
        }

        function showInjectionContent(id) {
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
            } catch {}
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
            } catch {}
        }
        function renderUpdatesBadge() {
            const badge = document.getElementById("updates-badge");
            if (!badge || !updatesState) return;
            const tools = (updatesState.tools || []).filter(t => t.hasUpdate);
            if (tools.length === 0) { badge.style.display = "none"; return; }
            const names = tools.map(t => `${t.name} → v${t.latestVersion}`).join("، ");
            badge.textContent = `🔄 ${tools.length === 1 ? "تحديث" : tools.length + " تحديثات"} متاحة`;
            badge.title = `${names}\n(انقر للتفاصيل)`;
            badge.style.display = "inline-block";
        }
        function openUpdatesPopup() {
            if (!updatesState) return;
            const tools = (updatesState.tools || []).filter(t => t.hasUpdate);
            if (tools.length === 0) return;
            const lines = tools.map(t => {
                const date = t.latestReleaseDate ? new Date(t.latestReleaseDate).toLocaleDateString() : "";
                return `${t.name}: v${t.localVersion || "?"} → v${t.latestVersion}${date ? " (" + date + ")" : ""}\n${t.latestUrl || ""}`;
            }).join("\n\n");
            // Show the right upgrade path: a plugin install updates from inside
            // Claude Code, a clone updates with git.
            const how = updatesState.pluginMode
                ? "\n\nللتحديث داخل Claude Code:\n/plugin marketplace update"
                : "\n\nللتحديث:\ngit pull ثم أعد تشغيل الخادم";
            alert("تحديثات متاحة:\n\n" + lines + how);
        }

        fetchConfig();
        fetchUpdates();
        setInterval(fetchConfig, 60_000);
        setInterval(fetchUpdates, 15 * 60_000);   // re-poll the cache every 15 min
        fetchData();

        // WebSocket
        // ===== Live Banner =====

        let liveBannerTimeout = null;
        const toolColors = { Create: '#04201a', Edit: '#2a2008', Read: '#082030', Bash: '#2a0a18', Agent: '#1a0a2a', Plan: '#2a2008' };
        const toolTextColors = { Create: 'var(--emerald)', Edit: 'var(--gold)', Read: 'var(--blue)', Bash: 'var(--pink)', Agent: '#bb86fc', Plan: 'var(--gold)' };

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
                const full = dir + '/' + name;
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
                    if (msg.type === "scan" || (msg.type === "hook" && msg.payload && (msg.payload.tool === "Create" || msg.payload.type === "create" || (msg.payload.tool === "Bash" && /rm |del /i.test(msg.payload.command || msg.payload.description || ''))))) {
                        fullRenderNeeded = true;
                        cachedTree = null;
                    }
                    // Debounce data refresh
                    if (!refreshQueued) {
                        refreshQueued = true;
                        setTimeout(() => {
                            refreshQueued = false;
                            fetchData();
                        }, 500);
                    }
                } catch {}
            };
            ws.onclose = () => {
                clearInterval(pingInterval);
                setTimeout(wsConnect, wsRetry);
                wsRetry = Math.min(wsRetry * 1.5, 15000);
            };
            ws.onerror = () => {
                try { ws.close(); } catch {}
            };
        }

        wsConnect();
