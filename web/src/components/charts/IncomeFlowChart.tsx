import { useMemo, useState } from 'react';
import ReactECharts from './ECharts';
import { api } from '../../api';
import { fmtBig, fmtPct } from '../../format';
import { CHART_COLORS, baseTextStyle } from './chartTheme';
import { useArchive } from '../useArchive';
import { flowLinks, type IncomeFlow } from '../../../../src/analysis/income-flow';
import Term from '../Term';

/**
 * Where the revenue goes, as filed: revenue into the cost of what was sold
 * and gross profit, gross profit into research, selling and administration
 * and operating income, operating income through tax to net income. In the
 * statements' own currency, for the last four quarters or any fiscal year.
 */
export default function IncomeFlowChart({ symbol }: { symbol: string }) {
  const { data } = useArchive(() => api.getIncomeFlow(symbol), [symbol]);
  const periods = useMemo(() => {
    if (!data) return [];
    const out: { key: string; label: string; flow: IncomeFlow }[] = [];
    if (data.ttm) out.push({ key: 'ttm', label: 'Letzte 4 Quartale', flow: data.ttm });
    for (const y of [...data.years].reverse()) out.push({ key: y.periodEnd, label: `GJ ${y.periodEnd.slice(0, 4)}`, flow: y });
    return out;
  }, [data]);
  const [key, setKey] = useState<string | null>(null);
  if (!data || periods.length === 0) return null;
  const current = periods.find((p) => p.key === key) ?? periods[0];
  const f = current.flow;
  const money = (v: number) => fmtBig(v, data.currency);
  const links = flowLinks(f);
  const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))];
  const kindOf = new Map<string, string>();
  for (const l of links) kindOf.set(l.target, l.kind === 'cost' ? 'cost' : kindOf.get(l.target) ?? 'income');
  for (const l of links) if (l.kind === 'gap') kindOf.set(l.source, 'gap');
  const color = (n: string) => (kindOf.get(n) === 'cost' ? CHART_COLORS.red : kindOf.get(n) === 'gap' ? CHART_COLORS.amber : n === 'Umsatz' ? CHART_COLORS.blue : CHART_COLORS.green);
  const margin = (v: number) => fmtPct(v / f.revenue, 1);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
          <Term k="concept.incomeFlow">Vom Umsatz zum Gewinn</Term>
        </h3>
        <div className="flex flex-wrap gap-1">
          {periods.map((p) => (
            <button
              key={p.key}
              onClick={() => setKey(p.key)}
              className={`rounded px-2 py-0.5 text-xs ${p.key === current.key ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:bg-ink-800'}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-2 text-xs text-ink-400">
        Umsatz {money(f.revenue)} · Bruttomarge {margin(f.grossProfit)} · operativ {margin(f.operatingIncome)} · netto{' '}
        <span className={f.netIncome >= 0 ? 'text-emerald-400' : 'text-red-400'}>{money(f.netIncome)} ({margin(f.netIncome)})</span>
        {data.currency && <span className="text-ink-500"> · in {data.currency}, wie berichtet</span>}
      </p>
      <div style={{ height: 300 }}>
        <ReactECharts
          style={{ height: '100%', width: '100%' }}
          notMerge
          option={{
            tooltip: {
              trigger: 'item', backgroundColor: CHART_COLORS.bg, borderColor: CHART_COLORS.grid,
              textStyle: { color: CHART_COLORS.text, fontSize: 13 },
              formatter: (p: { dataType: string; data: { source?: string; target?: string; value?: number }; name: string; value: number }) =>
                p.dataType === 'edge'
                  ? `${p.data.source} → ${p.data.target}: ${money(p.data.value ?? 0)} (${margin(p.data.value ?? 0)} vom Umsatz)`
                  : `${p.name}: ${money(p.value)}`,
            },
            series: [{
              type: 'sankey',
              left: 8, right: 150, top: 8, bottom: 8,
              nodeGap: 14, nodeWidth: 12, draggable: false,
              emphasis: { focus: 'adjacency' },
              data: nodes.map((n) => ({ name: n, itemStyle: { color: color(n), borderColor: color(n) } })),
              links: links.map((l) => ({ source: l.source, target: l.target, value: l.value })),
              lineStyle: { color: 'gradient', opacity: 0.35, curveness: 0.5 },
              label: {
                color: CHART_COLORS.text, fontSize: 12,
                formatter: (p: { name: string; value: number }) => `${p.name}\n${money(p.value)}`,
              },
            }],
            textStyle: baseTextStyle,
          }}
        />
      </div>
      {f.operatingIncome < 0 && (
        <p className="mt-1 text-xs text-ink-500">
          Gelb: der operative Verlust — die Kosten, die der Bruttogewinn nicht deckt, finanziert aus anderen Quellen.
        </p>
      )}
    </div>
  );
}
