        import { data, activeProject, headerBuilt, showCompletedPlans, plansTab, todosTab } from "./dashboard-state.js";
        import { API, esc, timeStr, destructiveHeaders, uiAlert, uiConfirm } from "./dashboard-core.js";
        import { currentVerdicts, updateCard } from "./dashboard-data.js";
        import { getProjectTags, patchHeader, buildHeaderOnce } from "./dashboard-project.js";
        import { renderFiles } from "./dashboard-tree-ws.js";

        // ===== المهام card + the shared الحالية/القادمة tabs =====
        // (moved here from dashboard-tree-ws.js with the upcoming feature — that
        // file sits at its size budget; the plans card below shares cardTabs.)

        export function cardTabs(active, action, counts) {
            const btn = (key, label, n) =>
                `<button class="log-filter${active === key ? ' active' : ''}" data-action="${action}" data-key="${key}">${label}${n ? ` <span class="tab-badge tab-badge-default">${n}</span>` : ''}</button>`;
            return `<div class="log-filters">${btn('current', 'الحالية', counts.current)}${btn('upcoming', 'القادمة', counts.upcoming)}</div>`;
        }
        const daysAgoStr = (ts) => {
            const d = Math.floor((Date.now() - new Date(ts)) / 86400000);
            return d <= 0 ? 'اليوم' : d === 1 ? 'منذ يوم' : d === 2 ? 'منذ يومين' : `منذ ${d} يوم`;
        };
        const addedTitle = (ts) => ts ? `أُضيف: ${String(ts).slice(0, 16).replace('T', ' ')}` : '';

        // Targeted refresh for the tasks card alone — the الحالية/القادمة tab
        // switch must not redraw the whole project (that re-fetched the changes
        // card and reset every card's scroll, reading as a full reload).
        // «الأكثر كسرًا» (#557): أعلى الملفات تكرارًا في بلاغات bug/security —
        // من حكم الخادم (verdicts.fragile) لا من مرآة عدّ في الواجهة، فلا انحراف
        // عن سطر retro المشتق من نفس المجموعة. يسكن هنا لا في tree-ws لأن سقف
        // ميزانية tree-ws مجمّد؛ بطاقة الأمان تستدعيه سطرًا واحدًا.
        export function fragileFilesHtml() {
            const { v } = currentVerdicts();
            const list = v?.fragile || [];
            if (!list.length) return '';
            let h = '<div style="font-size:0.7em;color:var(--text2);margin:10px 0 4px">الأكثر كسرًا</div>';
            for (const f of list) {
                h += `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:0.7em" title="ظهر في ${f.count} بلاغ خلل/أمان${f.open ? ` — منها ${f.open} ما زال مفتوحًا` : ''}">
                    <span style="color:var(--gold);flex-shrink:0">&#9888;</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:right;font-family:'Cascadia Code',Consolas,monospace">${esc(f.file)}</span>
                    <span style="color:${f.open ? 'var(--pink)' : 'var(--text2)'};flex-shrink:0;font-family:'Cascadia Code',Consolas,monospace">×${f.count}</span>
                </div>`;
            }
            return h;
        }

        export function renderTodosCard(flash = true) {
            updateCard('cardTodos', buildTodosHtml(getProjectTags()), flash);
        }

        export function buildTodosHtml(tags) {
            // Server verdicts (#379): each item renders exactly as ask:open and
            // the release guard see it — the client closure mirror is gone (it
            // had already drifted: it honored a trailing "#N" in prose, the
            // server only reads the leading run).
            const { v } = currentVerdicts();
            const openTodos = [], closedTodos = [], upcoming = [];
            const push = (t, isOpen, isDone, isBug) => {
                const item = (t.content || "").trim();
                if (!item) return;
                const entry = { text: item, num: typeof t.num === "number" ? t.num : null, ts: t.timestamp, bug: isBug };
                if (isOpen && t.upcoming) upcoming.push(entry);
                else if (isDone) closedTodos.push(entry);
                else if (isOpen) openTodos.push(entry);
            };
            if (v) {
                for (const t of v.todos) { if (t.state !== 'dropped') push(t, t.state === 'open', t.state === 'done', false); }
                // Deferred bugs live here (القادمة tab), not in the security card.
                for (const b of v.bugs) { if (b.open && b.upcoming) push(b, true, false, true); }
            } else {
                // No verdict snapshot → list every todo tag as OPEN, not an empty
                // (false all-clear) list; a transient /api/verdicts gap must not hide work (#394).
                for (const t of tags.filter(x => x.tag === 'todo')) push(t, true, false, false);
            }
            const numBadge = (n) => n != null
                ? `<span style="font-size:0.85em;color:var(--text2);font-family:'Cascadia Code',Consolas,monospace;flex-shrink:0">#${n}</span>`
                : '';
            const notes = tags.filter(t => t.tag === "note").slice(0, 5);
            let inner = '';
            if (todosTab === 'upcoming') {
                for (const t of upcoming) {
                    inner += `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em;direction:rtl" title="${esc(addedTitle(t.ts))}">
                        <span style="flex-shrink:0;color:var(--gold)">☾</span>
                        ${numBadge(t.num)}
                        <span style="flex:1">${t.bug ? '🐛 ' : ''}${esc(t.text)}</span>
                        <span style="color:var(--text2);font-size:0.85em;flex-shrink:0">${t.ts ? daysAgoStr(t.ts) : ''}</span>
                    </div>`;
                }
                if (!inner) inner = '<div style="font-size:0.7em;color:var(--text2)">لا توجد عناصر قادمة — أنشئ واحدًا بـ<code style="color:var(--gold)">-(upcoming)</code> أو حوّل مهمة بـ<code style="color:var(--gold)">-(upcoming) #N</code></div>';
            } else {
                for (const t of openTodos) {
                    inner += `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em;direction:rtl" title="${esc(addedTitle(t.ts))}">
                        <span style="width:10px;height:10px;border:1.5px solid var(--border);border-radius:2px;flex-shrink:0"></span>
                        ${numBadge(t.num)}
                        <span style="flex:1">${esc(t.text)}</span>
                    </div>`;
                }
                for (const t of closedTodos) {
                    inner += `<div style="display:flex;align-items:center;gap:5px;padding:2px 0;font-size:0.7em;direction:rtl;opacity:0.5" title="${esc(addedTitle(t.ts))}">
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
                if (!inner) inner = '<div style="font-size:0.7em;color:var(--text2)">لا توجد مهام</div>';
            }
            const tabs = cardTabs(todosTab, 'set-todos-tab', { current: openTodos.length, upcoming: upcoming.length });
            return `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">المهام</div>${tabs}<div style="overflow-y:auto;flex:1;min-height:0">${inner}</div>`;
        }

        export async function patchSessions(projectName) {
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

        export async function openSessionsPanel(projectName) {
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

        export async function killPid(pid, projectName) {
            if (!(await uiConfirm(`قتل العملية ${pid}؟`, { okText: "اقتل العملية" }))) return;
            // Visible failure on network error instead of a silent unhandled
            // rejection (R3 P7), matching the alert pattern used elsewhere.
            try {
                const r = await fetch(`${API}/api/kill-pid/${pid}`, { method: 'POST', headers: await destructiveHeaders() }).then(r => r.json());
                if (r.ok) openSessionsPanel(projectName);
                else uiAlert(`فشل: ${r.error || 'غير معروف'}`);
            } catch (e) {
                uiAlert(`فشل الاتصال بالخادم: ${e?.message || e}`);
            }
        }

        export async function refreshProcesses(projectName) {
            try {
                await fetch(`${API}/api/processes/refresh`, { method: 'POST' });
                openSessionsPanel(projectName);
            } catch (e) {
                uiAlert(`فشل تحديث العمليات: ${e?.message || e}`);
            }
        }

        const statsHashes = {};
        export function updateSidebarStats() {
            const el = document.getElementById('centerStats');
            if (!activeProject) { el.style.display = 'none'; return; }
            const tags = getProjectTags();
            const builts = tags.filter(t => t.tag === "built").length;
            const plans = (data.plans || []).filter(p => p.project === activeProject);

            // Open/closed counts come from the server verdicts (#379) — the same
            // resolvers behind ask:open and the release guard, so these numbers can
            // no longer contradict them. With NO snapshot (verdicts never fetched
            // for this project) default every item to OPEN by counting raw tags —
            // a transient /api/verdicts failure must never read as a green zero (#394).
            const { v, stale: verdictsStale } = currentVerdicts();
            const SEC_TAGS = new Set(['security', 'security:own', 'security:dep']);
            // «قادمة» items are deferred by design — they count neither as open
            // debt nor into the progress bars (parity with the release guard).
            const liveTodos = v ? v.todos.filter(t => t.state !== 'dropped' && !(t.upcoming && t.state === 'open'))
                                : tags.filter(t => t.tag === 'todo' && !t.upcoming).map(() => ({ state: 'open' }));
            const openTodos = liveTodos.filter(t => t.state === 'open').length;
            const bugsAll = v ? v.bugs.filter(b => !(b.open && b.upcoming))
                              : tags.filter(t => t.tag === 'bug found' && !t.upcoming).map(() => ({ open: true }));
            const openBugs = bugsAll.filter(b => b.open).length;
            const openSec = v ? v.security.filter(s => s.open).length
                              : tags.filter(t => SEC_TAGS.has(t.tag)).length;
            const outdatedCount = tags.filter(t => t.tag === "outdated").length;

            let totalSteps = 0, doneSteps = 0;
            for (const plan of plans) {
                if (plan.upcoming) continue;  // deferred plans sit outside the progress story
                const vs = plan.steps.filter(s => !s.dropped);  // dropped steps are archived, not open (#410)
                totalSteps += vs.length; doneSteps += vs.filter(s => s.completed).length;
            }
            totalSteps += liveTodos.length; doneSteps += (liveTodos.length - openTodos);

            // New separate card: 5 stat numbers. Guarded like the cards
            // (round-8 UI): this runs on every surgical pulse, and rewriting
            // identical markup is pure DOM churn.
            const numbersEl = document.getElementById('statsNumbers');
            if (numbersEl) {
                const numbersHtml = `
                    <div><div class="ss-val" style="color:var(--emerald)">${builts}</div><div class="ss-label">بناء</div></div>
                    <div><div class="ss-val" style="color:var(--gold)">${openTodos}</div><div class="ss-label">مهام</div></div>
                    <div><div class="ss-val" style="color:${openBugs > 0 ? 'var(--pink)' : 'var(--emerald)'}">${openBugs}</div><div class="ss-label">خلل</div></div>
                    <div><div class="ss-val" style="color:${openSec > 0 ? 'var(--pink)' : 'var(--emerald)'}">${openSec}</div><div class="ss-label">أمني</div></div>
                    <div><div class="ss-val" style="color:${outdatedCount > 0 ? 'var(--gold)' : 'var(--emerald)'}">${outdatedCount}</div><div class="ss-label">قديمة</div></div>
                `;
                if (statsHashes.numbers !== numbersHtml) {
                    statsHashes.numbers = numbersHtml;
                    numbersEl.innerHTML = numbersHtml;
                }
                numbersEl.style.display = 'flex';
                // Staleness indicator: dim + tooltip whenever /api/verdicts failed and
                // these numbers aren't live — either the last good snapshot or the
                // assumed-open fallback — so they're never silently trusted as live (#414).
                numbersEl.style.opacity = verdictsStale ? '0.5' : '1';
                numbersEl.title = verdictsStale
                    ? (v ? 'أحكام قديمة — تعذّر تحديث /api/verdicts؛ تُعرض آخر لقطة سليمة'
                         : 'تعذّر جلب /api/verdicts — تُعرض العناصر كمفتوحة افتراضًا')
                    : '';
            }

            // Existing capsule: bars only
            const bars = [];
            if (totalSteps > 0) {
                const pct = Math.min(100, Math.round((doneSteps / totalSteps) * 100));
                const tip = `تنفيذ الخطط والمهام: ${doneSteps}/${totalSteps} (${pct}%)`;
                bars.push(`<div class="progress-track" title="${tip}"><div class="progress-fill" style="width:${pct}%;background:var(--emerald)"></div></div>`);
            }
            if (bugsAll.length > 0) {
                const fixedCount = bugsAll.length - openBugs;
                const pct = Math.min(100, Math.round((fixedCount / bugsAll.length) * 100));
                const tip = `إصلاح الأخطاء المكتشفة: ${fixedCount}/${bugsAll.length} (${pct}%)`;
                bars.push(`<div class="progress-track" title="${tip}"><div class="progress-fill" style="width:${pct}%;background:var(--pink)"></div></div>`);
            }
            const barsHtml = bars.length > 0 ? `<div class="center-stats-bars">${bars.join('')}</div>` : '';
            if (statsHashes.bars !== barsHtml) {
                statsHashes.bars = barsHtml;
                el.innerHTML = barsHtml;
            }
            el.style.display = bars.length > 0 ? 'flex' : 'none';
        }

        // Per-plan expanded state (planId → bool). Most-recent plan defaults
        // to expanded; toggled by clicking the header. Survives re-renders so
        // a live tags update doesn't slam every plan shut on the user.
        export const planExpanded = {};
        // showCompletedPlans moved to dashboard-state.js (R3 #3) — core toggles it.

        export function renderActivePlanCard(project, flash = true) {
            const el = document.getElementById('cardActivePlan');
            if (!el) return;
            const everyPlan = (data.plans || [])
                // "has a non-dropped step" (not just length>0): dropped steps are now
                // retained (#410), so a fully-dropped plan must still read as empty.
                .filter(p => p.project === project && p.steps && p.steps.some(s => !s.dropped))
                .sort((a, b) => +new Date(b.updatedAt || b.timestamp) - +new Date(a.updatedAt || a.timestamp));
            // الحالية/القادمة split: a deferred plan lives in its own tab and
            // stops reading as active work (its steps don't gate anything).
            const upcomingPlans = everyPlan.filter(p => p.upcoming);
            const allPlans = everyPlan.filter(p => !p.upcoming);

            const isComplete = p => p.steps.every(s => s.completed || s.dropped);  // dropped counts as closed (#410)
            const completedPlans = allPlans.filter(isComplete);
            const currentPlans = showCompletedPlans ? allPlans : allPlans.filter(p => !isComplete(p));
            const projectPlans = plansTab === 'upcoming' ? upcomingPlans : currentPlans;

            const header = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">الخطط النشطة${projectPlans.length > 1 ? ` (${projectPlans.length})` : ''}</div>`
                + cardTabs(plansTab, 'set-plans-tab', { current: currentPlans.length, upcoming: upcomingPlans.length });

            if (projectPlans.length === 0 && (plansTab === 'upcoming' || completedPlans.length === 0)) {
                const hint = plansTab === 'upcoming'
                    ? 'لا خطط قادمة — أجّل خطة بزر ☾ أو بـ<code style="color:var(--gold);font-family:\'Cascadia Code\',monospace">-(upcoming) #N</code> على إحدى خطواتها.'
                    : 'لا توجد خطط نشطة. أرسل <code style="color:var(--gold);font-family:\'Cascadia Code\',monospace">-(doc:plan) name</code> لبدء واحدة.';
                updateCard('cardActivePlan', `${header}<div style="font-size:0.7em;color:var(--text2)">${hint}</div>`, flash);
                return;
            }

            // Default the newest plan open if no state yet.
            if (projectPlans.length > 0 && planExpanded[projectPlans[0].id] === undefined) {
                planExpanded[projectPlans[0].id] = true;
            }

            const sections = projectPlans.map((plan) => {
                const visible = plan.steps.filter(s => !s.dropped);  // archived dropped steps stay out of the view (#410)
                const done = visible.filter(s => s.completed).length;
                const total = visible.length;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                const expanded = !!planExpanded[plan.id];
                const arrow = expanded ? '▾' : '◂';
                // ☾ defer is meaningless on a complete plan (its steps gate
                // nothing) — disable it instead of offering a confusing no-op.
                // ⬆ promote stays live so a deferred-then-completed plan can
                // still be pulled back. The server rejects a complete defer
                // with 409 anyway (routes-plan); this is the UI half.
                const complete = isComplete(plan);
                const deferBtn = plan.upcoming
                    ? `<button data-action="toggle-plan-upcoming" data-plan-id="${esc(plan.id)}" data-upcoming="false" title="ترقية إلى الخطط الحالية" style="background:none;border:none;color:var(--emerald);cursor:pointer;font-size:0.85em;padding:0 4px;flex-shrink:0">⬆</button>`
                    : complete
                        ? `<button disabled title="الخطة مكتملة — التأجيل للخطط غير المكتملة فقط" style="background:none;border:none;color:var(--text2);opacity:0.35;cursor:default;font-size:0.85em;padding:0 4px;flex-shrink:0">☾</button>`
                        : `<button data-action="toggle-plan-upcoming" data-plan-id="${esc(plan.id)}" data-upcoming="true" title="تأجيل إلى القادمة (لا توقف الإصدار)" style="background:none;border:none;color:var(--gold);cursor:pointer;font-size:0.85em;padding:0 4px;flex-shrink:0">☾</button>`;

                const sortedSteps = [
                    ...visible.filter(s => !s.completed),
                    ...visible.filter(s => s.completed),
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
                        ${deferBtn}
                        <button data-action="hide-plan" data-plan-id="${esc(plan.id)}" data-plan-title="${esc(plan.title)}" title="إخفاء من الداشبورد (الملفات تبقى)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:0.85em;padding:0 4px;flex-shrink:0">👁️</button>
                    </div>
                    <div style="height:3px;background:var(--bg3)"><div style="width:${pct}%;height:100%;background:var(--emerald);transition:width 0.3s"></div></div>
                    ${expanded ? `<div style="padding:6px 8px;max-height:200px;overflow-y:auto">${stepRows}</div>` : ''}
                </div>`;
            }).join("");

            const completedToggle = plansTab === 'current' && completedPlans.length > 0
                ? `<div data-action="toggle-completed-plans" style="margin-top:6px;padding:5px 8px;font-size:0.7em;color:var(--text2);cursor:pointer;border-top:1px solid var(--border);user-select:none;text-align:center">
                     ${showCompletedPlans ? '◂ إخفاء' : '▾ إظهار'} ${completedPlans.length} خطة مكتملة
                   </div>`
                : '';

            updateCard('cardActivePlan',
                header
                + `<div style="overflow-y:auto;flex:1;min-height:0">${sections}</div>`
                + completedToggle,
                flash,
            );
        }

        export async function killServer(btn) {
            if (!(await uiConfirm("إيقاف السيرفر؟\nإذا كان مُشغَّلاً بـ`bun --watch` فسيعود تلقائياً، وإلا ستحتاج تشغيله يدوياً.", { okText: "أوقف السيرفر" }))) return;
            btn.classList.add("loading");
            btn.textContent = "...جاري الإيقاف";
            try {
                await fetch(`${API}/api/server/stop`, { method: "POST", headers: await destructiveHeaders({ "Content-Type": "application/json" }) });
            } catch { /* expected — server died mid-response */ }
            setTimeout(() => location.reload(), 1500);
        }

        // Defer a plan to «القادمة» or promote it back. Optimistic local patch —
        // the WS "plan" broadcast re-syncs the authoritative state right after.
        export async function togglePlanUpcoming(planId, upcoming) {
            try {
                const res = await fetch(`${API}/api/plan/${encodeURIComponent(planId)}/upcoming`, {
                    method: "POST",
                    headers: await destructiveHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({ upcoming }),
                });
                if (!res.ok) {
                    let msg = "فشل تبديل حالة الخطة";
                    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* non-JSON error body */ }
                    uiAlert(msg);
                    return;
                }
                const p = (data.plans || []).find(x => x.id === planId);
                if (p) { if (upcoming) p.upcoming = true; else delete p.upcoming; }
                renderActivePlanCard(activeProject);
                updateSidebarStats();
            } catch (e) {
                uiAlert(`خطأ: ${e.message}`);
            }
        }

        export async function hidePlan(planId, planTitle) {
            if (!(await uiConfirm(`إخفاء الخطة "${planTitle}" من الداشبورد؟\nالملفات (.md/.html) تبقى — يمكن استعادتها بإعادة إرسال -(doc:plan) بنفس الاسم.`, { okText: "أخفِ الخطة" }))) return;
            try {
                const res = await fetch(`${API}/api/plan/${encodeURIComponent(planId)}`, { method: "DELETE", headers: await destructiveHeaders() });
                if (res.ok) {
                    data.plans = (data.plans || []).filter(p => p.id !== planId);
                    delete planExpanded[planId];
                    renderActivePlanCard(activeProject);
                } else {
                    uiAlert("فشل الإخفاء");
                }
            } catch (e) {
                uiAlert(`خطأ: ${e.message}`);
            }
        }

        const CHANGES_HEADER = `<div style="font-size:0.6em;color:var(--text2);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">التغييرات في الكود</div>`;
        const CHANGES_LIST_STYLE = `overflow-y:auto;flex:1;min-height:0;direction:ltr;font-size:0.72em`;

        export async function renderChangesCard(project) {
            const el = document.getElementById('cardChanges');
            if (!el) return;
            // Loading placeholder ONLY on a first paint (fresh card after a full
            // render / project switch). The surgical WS path used to wipe the
            // card to "جاري التحميل…" on EVERY pulse and rebuild it after the
            // fetch — a visible blink + scroll reset whenever any OTHER card's
            // data changed (round-8 UI finding; pinned by ui-smoke scenario E).
            if (!el.querySelector('#changesList')) {
                updateCard('cardChanges', `${CHANGES_HEADER}<div id="changesList" style="${CHANGES_LIST_STYLE}">جاري التحميل…</div>`, false);
            }
            try {
                const r = await fetch(`${API}/api/changes?project=${encodeURIComponent(project)}&n=30`);
                const j = await r.json();
                // Stale guard: a slow response landing after a project switch
                // must not paint the previous project's changes into this card.
                if (activeProject !== project) return;
                const items = j.items || [];
                let listHtml;
                if (!items.length) {
                    listHtml = `<div style="color:var(--text2);font-size:0.95em;text-align:center;padding-top:12px">لا توجد تعديلات بعد</div>`;
                } else {
                    listHtml = items.map(it => {
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
                            <button class="ch-story" data-file="${esc(it.file_path || '')}" title="قصة الملف" style="background:transparent;border:1px solid var(--border);color:var(--text2);border-radius:6px;padding:1px 6px;cursor:pointer;font-family:inherit">📍</button>
                        </div>
                    </div>`;
                    }).join('');
                }
                // Hash-guarded like every other card: identical content → no DOM
                // write, old nodes + their listeners stay; changed → rewrite,
                // flash, and rebind into the fresh nodes.
                const wrote = updateCard('cardChanges', `${CHANGES_HEADER}<div id="changesList" style="${CHANGES_LIST_STYLE}">${listHtml}</div>`);
                if (!wrote) return;
                const list = document.getElementById('changesList');
                if (!list) return;
                list.querySelectorAll('.ch-row').forEach(row => {
                    row.addEventListener('click', () => openDiffModal(row.dataset.id));
                });
                list.querySelectorAll('.ch-story').forEach(btn => {
                    btn.addEventListener('click', ev => { ev.stopPropagation(); openFileStoryModal(project, btn.dataset.file); });
                });
            } catch (e) {
                const list = document.getElementById('changesList');
                if (list) list.innerHTML = `<div style="color:var(--pink)">فشل تحميل التغييرات: ${esc(String(e.message || e))}</div>`;
            }
        }

        // ذاكرة الموضع (#486): قصة ملف واحد — التاقات التي لمسته + تعديلاته
        // (deep=1 يسحب أيضًا أحداث الأرشيف البارد عند الطلب).
        async function openFileStoryModal(project, filePath) {
            try {
                const r = await fetch(`${API}/api/file-story?project=${encodeURIComponent(project)}&path=${encodeURIComponent(filePath)}&deep=1`);
                if (!r.ok) return;
                const s = await r.json();
                const fname = (s.file || '').split('/').pop();
                const tagRows = (s.tags || []).map(t => `
                    <div style="padding:7px 10px;border-bottom:1px solid var(--border)">
                        <div style="display:flex;gap:8px;align-items:baseline">
                            <span style="color:var(--gold);font-size:0.85em">${esc(t.tag)}${typeof t.num === 'number' ? ` #${t.num}` : ''}</span>
                            <span style="color:var(--text2);font-size:0.75em">${esc(timeStr(t.timestamp))}</span>
                        </div>
                        <div style="color:var(--text);font-size:0.9em;margin-top:2px">${esc(t.content)}</div>
                    </div>`).join('') || `<div style="color:var(--text2);padding:10px;font-size:0.9em">لا تاقات مرتبطة بهذا الملف بعد</div>`;
                const evs = [...(s.events || []), ...(s.archived || [])];
                const evRows = evs.map(e => `
                    <div class="fs-ev" data-id="${esc(e.id)}" data-full="${e.has_full_content ? '1' : ''}" style="display:flex;gap:10px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--border);${e.has_full_content ? 'cursor:pointer' : ''}">
                        <span style="color:var(--text2);font-size:0.8em">${esc(timeStr(e.timestamp))}</span>
                        <span style="color:var(--text2);font-size:0.85em">${esc(e.action || '')}</span>
                        ${e.lines_added > 0 ? `<span style="color:var(--emerald);font-size:0.85em">+${e.lines_added}</span>` : ''}
                        ${e.lines_removed > 0 ? `<span style="color:var(--pink);font-size:0.85em">−${e.lines_removed}</span>` : ''}
                        ${e.has_full_content ? '' : `<span style="color:var(--text2);font-size:0.75em">·archived</span>`}
                    </div>`).join('') || `<div style="color:var(--text2);padding:10px;font-size:0.9em">لا تعديلات مسجلة</div>`;
                const overlay = document.createElement('div');
                overlay.id = 'fileStoryOverlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:30px';
                overlay.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;width:100%;max-width:700px;max-height:100%;display:flex;flex-direction:column">
                    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
                        <span>📍</span>
                        <span style="font-family:'Cascadia Code',Consolas,monospace;color:var(--gold);font-size:0.9em;direction:ltr">${esc(fname)}</span>
                        <span style="color:var(--text2);font-size:0.72em;direction:ltr;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.file || '')}</span>
                        <button id="fsClose" style="margin-right:auto;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 12px;cursor:pointer;font-family:inherit;flex-shrink:0">إغلاق</button>
                    </div>
                    <div style="overflow:auto;flex:1">
                        <div style="padding:8px 10px;color:var(--text2);font-size:0.8em;border-bottom:1px solid var(--border)">التاقات (${(s.tags || []).length})</div>
                        ${tagRows}
                        <div style="padding:8px 10px;color:var(--text2);font-size:0.8em;border-bottom:1px solid var(--border)">التعديلات (${evs.length})</div>
                        ${evRows}
                    </div>
                </div>`;
                document.body.appendChild(overlay);
                const close = () => overlay.remove();
                overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
                overlay.querySelector('#fsClose').addEventListener('click', close);
                document.addEventListener('keydown', function once(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', once); } });
                overlay.querySelectorAll('.fs-ev[data-full="1"]').forEach(rw => {
                    rw.addEventListener('click', () => openDiffModal(rw.dataset.id));
                });
            } catch (e) {
                uiAlert(`فشل تحميل قصة الملف: ${e.message}`);
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
            } catch {
                // Diff fetch failed — just don't open the overlay.
            }
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

        export function renderProject() {
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

        export const extIcons = {
            ts: "#3178c6", js: "#f7df1e", py: "#3776ab", rs: "#dea584",
            go: "#00add8", html: "#e34f26", css: "#1572b6", json: "#ffd166",
            md: "#777777", sh: "#4eaa25", toml: "#9c4121", yaml: "#cb171e",
            yml: "#cb171e", sql: "#336791", vue: "#42b883", svelte: "#ff3e00",
        };

        // ctxTargetPath/ctxTargetFile moved to dashboard-state.js (R3 #3) —
        // tree-ws sets them on right-click and reads them in the actions.

