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

