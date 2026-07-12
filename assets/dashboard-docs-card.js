        // The «الذاكرة والتوثيق» card — memory files (Claude's per-project
        // memory, scan-time) + the stored docs (.devlog/docs, live /api/docs).
        // Extracted from dashboard-tree-ws.js when the docs section absorbed
        // the retired «دراسات» header chip (anti-bloat ratchet).
        import { data, activeProject } from "./dashboard-state.js";
        import { API, esc } from "./dashboard-core.js";

        const typeLabels = { user: 'مستخدم', feedback: 'ملاحظة', project: 'مشروع', reference: 'مرجع' };
        const typeColors = { user: 'var(--blue)', feedback: 'var(--gold)', project: 'var(--emerald)', reference: '#bb86fc' };

        // Doc-type vocabulary of the docs section (inherited from the retired
        // «دراسات» header chip when it folded into this card). A study is a
        // doc:report whose name carries the study-/دراسة- watermark prefix.
        const DOC_TYPE_AR = { report: 'تقرير', analysis: 'تحليل', comparison: 'مقارنة', readme: 'readme' };
        const isStudyDoc = (name) => /^\s*(study|دراسة)([\s\-_:.]|$)/i.test(name || '');
        // Own-property lookup only: a hand-edited index.json with type
        // "constructor" must fall through to esc(), not the Object prototype.
        const docTypeLabel = (name, type) => isStudyDoc(name) ? 'دراسة'
            : Object.hasOwn(DOC_TYPE_AR, type) ? DOC_TYPE_AR[type] : String(type || '');

        // The docs section renders from /api/docs (live index), NOT from the
        // scanner's docFiles — writeDoc emits no frontmatter so readMdFiles
        // always skipped the docs dir and that path stayed permanently empty.
        // refreshDocsCard mirrors the fetched list into project.docFiles so the
        // shared hover-popover lookup (dashboard-core, kind "docs" → docFiles by
        // row index) keeps working with rows in fetch order (newest first).
        export async function refreshDocsCard(projectName) {
            const p = data.projects[projectName];
            if (!p) return;
            try {
                const r = await fetch(`${API}/api/docs?project=${encodeURIComponent(projectName)}`);
                const { docs = [] } = await r.json();
                const sig = JSON.stringify(docs.map(d => [d.slug, d.updatedAt]));
                if (p.__docsSig === sig) return;
                p.__docsSig = sig;
                p.docFiles = [...docs]
                    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
                    .map(d => ({
                        file: `${d.slug}.md`,
                        slug: d.slug,
                        docType: d.type,
                        name: d.name,
                        description: `${docTypeLabel(d.name, d.type)}${d.updatedAt ? ` — آخر تحديث ${String(d.updatedAt).slice(0, 10)}` : ''}`,
                        body: d.preview || 'المعاينة غير متاحة — اضغط سطر الوثيقة لفتح صفحتها الكاملة',
                    }));
                if (activeProject === projectName) {
                    const card = document.getElementById('cardDocs');
                    if (card) card.innerHTML = buildDocsHtml(p);
                }
            } catch { /* keep the last rendered card on a transient fetch failure */ }
        }

        // Clicking a docs row opens the rendered HTML page in its own tab
        // (the hover popover stays the quick raw-markdown preview).
        document.addEventListener('click', (e) => {
            const row = e.target.closest('.mem-row[data-doc-slug]');
            if (!row) return;
            window.open(`${API}/api/doc-page?project=${encodeURIComponent(activeProject)}&slug=${encodeURIComponent(row.dataset.docSlug)}`, '_blank', 'noopener');
        });

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
                    const color = isStudyDoc(d.name) ? 'var(--gold)' : 'var(--emerald)';
                    h += `<div class="mem-row" data-mem-kind="docs" data-mem-idx="${i}" data-doc-slug="${esc(d.slug || '')}" title="اضغط لفتح الصفحة الكاملة" style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:0.7em">
                        <span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0"></span>
                        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.name || d.file)}</span>
                        <span style="font-size:0.8em;color:${color};flex-shrink:0">${esc(docTypeLabel(d.name, d.docType))}</span>
                    </div>`;
                });
            }

            if (total === 0) {
                h += '<div style="color:var(--text2);font-size:0.7em">لا توجد ملفات</div>';
            }

            h += '</div>';
            return h;
        }
