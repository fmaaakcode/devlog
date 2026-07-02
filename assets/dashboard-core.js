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
            // Converted from the last inline onclick handlers in dashboard.html
            // (report #5) so CSP can drop script-src 'unsafe-inline'. `el` replaces
            // the old `this`; activeProject is the shared global.
            else if (action === "rescan-project") rescanProject(activeProject, el);
            else if (action === "vuln-scan") vulnScan(activeProject, el);
            else if (action === "open-injection-panel") openInjectionPanel(activeProject);
            else if (action === "open-standards-panel") openStandardsPanel(activeProject);
            else if (action === "kill-server") killServer(el);
            else if (action === "open-updates-popup") openUpdatesPopup();
            else if (action === "open-target-file") openTargetFile();
            else if (action === "ignore-target") ignoreTarget();
            else if (action === "close-injection-panel") closeInjectionPanel();
            else if (action === "close-standards-panel") closeStandardsPanel();
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

