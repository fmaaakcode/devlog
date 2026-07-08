        import { data, activeProject, setActiveProject, headerBuilt, setHeaderBuilt, setCachedTree, setFullRenderNeeded } from "./dashboard-state.js";
        import { API, esc, safeHref, langColors, destructiveHeaders, uiAlert, uiConfirm, uiPrompt, activeSessionsByProject } from "./dashboard-core.js";
        import { summaryTagCounts, summaryVulnClass, summaryLastActivity, summaryOrphans, summaryTombstones, summaryUntagged, summaryUntaggedBy, ACTIVE_WINDOW_MS, fetchProjectView, refreshActiveView } from "./dashboard-data.js";
        import { patchSessions } from "./dashboard-panels.js";

        function renderProjectItem(name) {
            const p = data.projects[name];
            // Counts + vuln verdict come from the summary maps in both modes
            // (#379) — the server judges, the sidebar displays.
            const tagCount = summaryTagCounts[name] || 0;
            const color = langColors[p.language] || langColors.default;
            const vulnCls = summaryVulnClass[name] || '';
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

        export function renderSidebar() {
            const elActive = document.getElementById("projectListActive");
            const elOther = document.getElementById("projectListOther");
            const names = Object.keys(data.projects);
            if (names.length === 0) {
                elActive.innerHTML = '<div class="sidebar-empty">لا توجد مشاريع بعد<br>ابدأ العمل في أي مشروع وسيظهر هنا تلقائياً</div>';
                elOther.innerHTML = '';
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

            elActive.innerHTML = renderCard("نشطة (آخر 7 أيام)", active, "لا توجد مشاريع نشطة");
            elOther.innerHTML = renderCard("باقي المشاريع", other, "لا يوجد");
            renderMaintRow();
        }

        // Sweep buttons (#375/#380) — visible only when there's something to
        // clean; counts arrive with the summary in both modes.
        function renderMaintRow() {
            const el = document.getElementById('maintRow');
            if (!el) return;
            const btn = (action, label) =>
                `<button data-action="${action}" style="width:100%;text-align:right;background:none;border:1px dashed var(--border);border-radius:6px;color:var(--text2);font-size:0.7em;padding:5px 10px;cursor:pointer;margin-top:6px">${label}</button>`;
            let h = '';
            if (summaryTombstones > 0) h += btn('cleanup-tombstones', `🪦 مشاريع مفقودة من القرص 30+ يومًا (${summaryTombstones})`);
            if (summaryOrphans > 0) h += btn('cleanup-orphans', `🧹 أسماء يتيمة في السجلات (${summaryOrphans})`);
            // Passive compliance counter (#434) — informational only, no action:
            // sessions that wrote code but stored no tags (server-computed, ~30d
            // window). #447: the tooltip names WHICH projects and how many each,
            // instead of a generic explanation.
            if (summaryUntagged > 0) {
                const perProject = Object.entries(summaryUntaggedBy)
                    .sort((a, b) => b[1] - a[1])
                    .map(([n, c]) => `${n}: ${c}`)
                    .join(' · ');
                h += `<div title="${esc(perProject || 'جلسات هادئة عدّلت ملفات ولم تسجّل أي تاق')}" style="width:100%;text-align:right;border:1px dashed var(--border);border-radius:6px;color:var(--text2);font-size:0.7em;padding:5px 10px;margin-top:6px;opacity:0.8">👻 جلسات كتبت كودًا بلا تاقات (${summaryUntagged})</div>`;
            }
            el.innerHTML = h;
            el.style.display = h ? '' : 'none';
        }

        export async function cleanupTombstones() {
            if (!(await uiConfirm('حذف المشاريع التي اختفى مجلدها من القرص منذ 30+ يومًا نهائيًا بكل بياناتها (تاقات/أحداث/خطط)؟', { okText: 'احذف نهائيًا' }))) return;
            try {
                const r = await fetch(`${API}/api/cleanup-tombstones`, {
                    method: 'POST',
                    headers: await destructiveHeaders({ 'Content-Type': 'application/json' }),
                    body: '{}',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { uiAlert(j.error || 'فشل الكنس'); return; }
                uiAlert(j.removed?.length ? `حُذفت: ${j.removed.join('، ')}` : 'لا شيء مؤهلًا للحذف (المجلدات عادت أو العلامات حديثة)');
            } catch { uiAlert('تعذّر الاتصال بالخادم'); }
            refreshActiveView(true);
        }

        export async function cleanupOrphans() {
            try {
                const r = await fetch(`${API}/api/orphan-projects`);
                const { orphans } = await r.json();
                if (!orphans?.length) { uiAlert('لا أسماء يتيمة'); refreshActiveView(true); return; }
                const names = orphans.map(o => o.name);
                const sample = names.slice(0, 12).join('، ') + (names.length > 12 ? ` … و${names.length - 12} أخرى` : '');
                if (!(await uiConfirm(`حذف بيانات ${names.length} اسمًا يتيمًا (تاقات/أحداث/خطط لأسماء غير مسجّلة كمشاريع)؟\n\n${sample}\n\nلا يمسّ أي مشروع مسجّل.`, { okText: 'طهّر اليتائم' }))) return;
                const res = await fetch(`${API}/api/cleanup-orphans`, {
                    method: 'POST',
                    headers: await destructiveHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ names }),
                });
                const j = await res.json().catch(() => ({}));
                if (!res.ok) { uiAlert(j.error || 'فشل التطهير'); return; }
                uiAlert(`نُظّف ${j.removed?.length ?? 0} اسمًا (${j.removedEntries ?? 0} سجلًّا حُذف)`);
            } catch { uiAlert('تعذّر الاتصال بالخادم'); }
            refreshActiveView(true);
        }

        export async function renameProject(name) {
            const next = await uiPrompt(`إعادة تسمية المشروع "${name}"\nسيُعاد تسمية مجلده على القرص أيضاً (إن وُجد)، وتنتقل التاقات والميموري.`, name, { title: 'إعادة تسمية', okText: 'أعد التسمية' });
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
                if (!res.ok) { uiAlert(result.error || "تعذّرت إعادة التسمية"); return; }
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
                if (sk) uiAlert(`تمّت إعادة التسمية.\nتُخطّي ${sk} بطاقة ميموري لوجود نظيرة لها في الوجهة (لم تُطمَس).`);
                // The WS "rename" broadcast refreshes data; switch selection if needed.
                if (activeProject === name) { setActiveProject(newName); setHeaderBuilt(false); setCachedTree(null); }
                await refreshActiveView(true);
            } catch { uiAlert("تعذّر الاتصال بالخادم"); }
        }

        export async function deleteProject(name) {
            if (!(await uiConfirm(`حذف المشروع "${name}"؟\nسيتم حذف جميع التاقات والأحداث المرتبطة به.`, { okText: "احذف المشروع" }))) return;
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
                title: hasAbout ? 'مرر الماوس لعرض التفاصيل' : 'لا يوجد about — أرسل -(about) لإضافته',
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
            return `<span id="hdr-git" data-remote="" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a1a;color:var(--text2);font-weight:600" title="No git remote configured">📁 local</span>`;
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
                <span class="brand-version" id="hdr-next-release" data-action="open-release-preview" style="cursor:pointer;border-style:dashed;opacity:0.75" title="معاينة الإصدار القادم قبل إصداره — تُولَّد حيًّا ولا تكتب شيئًا">القادم ⏳</span>
                <span class="brand-version" id="hdr-client-report" data-action="open-client-report" style="cursor:pointer;opacity:0.85" title="تقرير حالة موجّه للعميل: قدرات النظام وآخر إصدار والاعتمادية — أعداد فقط بلا تفاصيل داخلية أو أمنية">تقرير العميل 🧾</span>
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
                <span class="stats-btn" id="hdr-feats">
                    <span>قدرات</span>
                    <span class="stats-count" id="hdr-feats-count">0</span>
                    <div class="stats-popup" id="hdr-feats-popup" style="min-width:300px;max-width:420px;text-align:right"></div>
                </span>
                <span class="lang-badge" id="hdr-lang" style="background:${color}18; color:${color}">${esc(p.language)}</span>
                <span class="framework-badge" id="hdr-framework" style="background:#04201a;color:var(--emerald);${p.framework ? '' : 'display:none'}">${esc(p.framework || '')}</span>
                <span id="hdr-runtime" style="font-size:0.7em;padding:2px 8px;border-radius:4px;background:#1a1a2e;color:#7c8cf5;font-weight:600;${p.runtime ? '' : 'display:none'}">${p.runtime ? `${esc(p.runtime.name || '')}${p.runtime.version ? ` ${esc(p.runtime.version)}` : ''}${p.runtime.edition ? ` · ${esc(p.runtime.edition)}` : ''}` : ''}</span>
                ${gitBadgeHtml(p)}
                <span id="hdr-sessions" data-action="open-sessions" data-project="${esc(p.name)}" style="display:none;font-size:0.7em;padding:2px 8px;border-radius:4px;background:#0d2e1f;color:#06d6a0;font-weight:600;cursor:pointer" title="جلسات Claude النشطة"></span>
            `;
            document.getElementById("topbar").classList.add("has-project");

            const hasAbout = !!(p.about?.trim());
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
            setHeaderBuilt(true);
            patchLibraries(p);
            patchFileExts(p);
            patchSessions(p.name);
            patchStatsButton(p, tags);
            patchFeaturesButton(p);
        }

        // «قدرات» header chip — the client-language capability inventory
        // (feature tags, resolved server-side: updates applied, removed
        // dropped, each attributed to the release that shipped it). Hover
        // lists them; click opens the full client report.
        async function patchFeaturesButton(p) {
            const btn = document.getElementById('hdr-feats');
            const popup = document.getElementById('hdr-feats-popup');
            const countEl = document.getElementById('hdr-feats-count');
            if (!btn || !popup || !countEl) return;
            try {
                const r = await fetch(`${API}/api/features?project=${encodeURIComponent(p.name)}`);
                const { features = [] } = await r.json();
                if (countEl.textContent !== String(features.length)) countEl.textContent = features.length;
                if (!features.length) {
                    popup.innerHTML = '<div class="stats-section-title">قدرات المشروع</div><div style="font-size:0.75em;color:var(--text2);padding:4px 0">لا قدرات مسجّلة بعد — تُعلَن بوسم <code style="color:var(--gold)">-(feature)</code> عند اكتمال قدرة يلمسها العميل</div>';
                } else {
                    const rows = [...features].reverse().map(f => `
                        <div class="stats-row" style="gap:10px" title="${esc(f.addedAt ? `أُضيفت: ${String(f.addedAt).slice(0, 16).replace('T', ' ')}` : '')}">
                            <span class="stats-key" style="flex:1;white-space:normal;line-height:1.5">${esc(f.text)}</span>
                            <span class="stats-value" style="flex-shrink:0;color:${f.sinceVersion ? 'var(--emerald)' : 'var(--gold)'}" title="${f.sinceVersion ? 'الإصدار الذي شحن هذه القدرة' : 'لم تُشحَن في إصدار بعد'}">${f.sinceVersion ? esc(f.sinceVersion) : 'قادمة'}</span>
                        </div>`).join('');
                    popup.innerHTML = `<div class="stats-section-title">قدرات المشروع</div><div class="stats-grid">${rows}</div>`;
                }
                btn.title = 'ما يقدر عليه النظام اليوم — اضغط لفتح تقرير العميل';
                btn.onclick = (e) => {
                    if (e.target.closest('.stats-popup')) return;
                    window.open(`${API}/api/client-report?project=${encodeURIComponent(p.name)}`, '_blank', 'noopener');
                };
            } catch { /* keep the last rendered popup on a transient fetch failure */ }
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

        export function patchLibraries(p) {
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
                const vulnTitle = v && v.vulns > 0 ? `${v.vulns} ثغرة${v.topVuln ? ` — ${v.topVuln.id} (${v.topVuln.severity}${v.topVuln.score ? ` ${v.topVuln.score}` : ''})` : ''}${sev && sev !== 'none' ? ` — خطورة: ${sev}` : ''}` : '';
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

            // File extensions — surgical per-badge
            patchFileExts(p);

            // Active Claude sessions + background processes
            patchSessions(p.name);

            // Stats popup (files, libs, dirs, tags, exts)
            patchStatsButton(p, tags);

            // Capability inventory chip (server-resolved feature list)
            patchFeaturesButton(p);
        }

