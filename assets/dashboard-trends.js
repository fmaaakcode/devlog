        // Hand-rolled SVG line chart for the stats-popup trends tab (#788), on
        // the md-render philosophy: a deliberate tiny subset (three fixed
        // series over month buckets), zero dependencies, sanitized output.
        // Pure string → string so the module is unit-testable without a DOM;
        // colors are CSS vars so the chart follows the dashboard theme.

        // Series order == legend order == draw order (last drawn sits on top).
        export const TREND_SERIES = [
            { key: 'opened', color: 'var(--gold)' },
            { key: 'closed', color: 'var(--emerald)' },
            { key: 'released', color: '#7c8cf5' },
        ];

        // Readability cap inside a ~300px popup — older months are dropped,
        // not aggregated. The full history stays on the /api/trends payload.
        export const TREND_MAX_MONTHS = 24;

        const W = 280, H = 120, PAD_L = 26, PAD_R = 8, PAD_T = 6, PAD_B = 16;

        // `?? ""` matches the other five client-side escapers: a bare String(s)
        // would render null/undefined as literal text inside the SVG.
        const escXml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c] ?? c));

        // "2026-08" → "08/26" (digits render LTR in both page directions).
        const fmtMonth = (m) => /^\d{4}-\d{2}$/.test(m) ? `${m.slice(5, 7)}/${m.slice(2, 4)}` : m;

        const val = (row, key) => Math.max(0, Number(row?.[key]) || 0);

        /** Rows → inline SVG (or '' when there is nothing to draw). Rows are
         *  `{ month: "YYYY-MM", opened, closed, released }` from /api/trends. */
        export function trendsSvg(monthlyRaw) {
            const monthly = (Array.isArray(monthlyRaw) ? monthlyRaw : [])
                .filter(r => r && typeof r.month === 'string')
                .slice(-TREND_MAX_MONTHS);
            if (!monthly.length) return '';

            const innerW = W - PAD_L - PAD_R;
            const innerH = H - PAD_T - PAD_B;
            const max = Math.max(1, ...monthly.map(r => Math.max(...TREND_SERIES.map(s => val(r, s.key)))));
            const x = (i) => monthly.length === 1
                ? PAD_L + innerW / 2
                : PAD_L + (i * innerW) / (monthly.length - 1);
            const y = (v) => PAD_T + innerH - (v / max) * innerH;
            const fx = (n) => n.toFixed(1);

            const parts = [];

            // Grid: three horizontal rules (0, mid, max) with y labels.
            for (const v of [0, max / 2, max]) {
                const gy = fx(y(v));
                parts.push(`<line x1="${PAD_L}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}" stroke="var(--border)" stroke-width="0.5"/>`);
                parts.push(`<text x="${PAD_L - 4}" y="${fx(y(v) + 2.5)}" text-anchor="end" font-size="7" fill="var(--text2)">${Math.round(v)}</text>`);
            }

            // X labels: first / middle / last month (deduped for short spans).
            const li = [...new Set([0, Math.floor((monthly.length - 1) / 2), monthly.length - 1])];
            for (const i of li) {
                const anchor = i === 0 ? 'start' : i === monthly.length - 1 ? 'end' : 'middle';
                parts.push(`<text x="${fx(x(i))}" y="${H - 4}" text-anchor="${anchor}" font-size="7" fill="var(--text2)">${escXml(fmtMonth(monthly[i].month))}</text>`);
            }

            for (const s of TREND_SERIES) {
                const pts = monthly.map((r, i) => `${fx(x(i))},${fx(y(val(r, s.key)))}`);
                if (pts.length > 1) {
                    parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
                }
                parts.push(`<circle cx="${fx(x(monthly.length - 1))}" cy="${fx(y(val(monthly[monthly.length - 1], s.key)))}" r="2" fill="${s.color}"/>`);
            }

            return `<svg viewBox="0 0 ${W} ${H}" role="img" style="width:100%;height:auto;display:block">${parts.join('')}</svg>`;
        }
