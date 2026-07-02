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

