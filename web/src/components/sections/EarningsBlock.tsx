import EarningsSurpriseChart from '../charts/EarningsSurpriseChart';
import ForwardGrowthChart from '../charts/ForwardGrowthChart';
import { fmt, fmtBig } from '../../format';

interface Props {
  financials: any;
}

export default function EarningsBlock({ financials: f }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {f.earningsSurprises?.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Past Surprises (last 4 qtrs)
          </h3>
          <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 200 }}>
            <EarningsSurpriseChart surprises={f.earningsSurprises} />
          </div>
          <table className="mt-2 w-full text-xs tabular">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="py-1 pr-2 text-left font-medium">Qtr</th>
                <th className="py-1 px-2 text-right font-medium">Estimate</th>
                <th className="py-1 px-2 text-right font-medium">Actual</th>
                <th className="py-1 pl-2 text-right font-medium">Surprise</th>
              </tr>
            </thead>
            <tbody>
              {f.earningsSurprises.map((q: any, i: number) => (
                <tr key={i} className="border-b border-ink-800">
                  <td className="py-1 pr-2 text-ink-300">{q.quarter}</td>
                  <td className="py-1 px-2 text-right font-mono text-ink-100">{fmt(q.epsEstimate, '', 2)}</td>
                  <td className="py-1 px-2 text-right font-mono text-ink-100">{fmt(q.epsActual, '', 2)}</td>
                  <td className={`py-1 pl-2 text-right font-mono ${q.surprisePct == null ? 'text-ink-500' : q.surprisePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {q.surprisePct == null ? '—' : `${q.surprisePct >= 0 ? '+' : ''}${(q.surprisePct * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {f.earningsEstimates?.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Forward Estimates (analyst consensus)
          </h3>
          <div className="rounded border border-ink-800 bg-ink-950 p-2" style={{ height: 200 }}>
            <ForwardGrowthChart estimates={f.earningsEstimates} />
          </div>
          <table className="mt-2 w-full text-xs tabular">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="py-1 pr-2 text-left font-medium">Period</th>
                <th className="py-1 px-2 text-right font-medium">EPS</th>
                <th className="py-1 px-2 text-right font-medium">YoY</th>
                <th className="py-1 px-2 text-right font-medium">Revenue</th>
                <th className="py-1 pl-2 text-right font-medium">YoY</th>
              </tr>
            </thead>
            <tbody>
              {f.earningsEstimates.map((e: any, i: number) => {
                const map: Record<string, string> = { '0q': 'Cur Q', '+1q': 'Nxt Q', '0y': 'Cur Y', '+1y': 'Nxt Y' };
                return (
                  <tr key={i} className="border-b border-ink-800">
                    <td className="py-1 pr-2 text-ink-300">{map[e.period] ?? e.period}</td>
                    <td className="py-1 px-2 text-right font-mono text-ink-100">{e.epsEstimate ? `$${e.epsEstimate.toFixed(2)}` : '—'}</td>
                    <td className={`py-1 px-2 text-right font-mono ${e.epsGrowth > 0 ? 'text-emerald-400' : e.epsGrowth < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                      {e.epsGrowth === null ? '—' : `${e.epsGrowth >= 0 ? '+' : ''}${(e.epsGrowth * 100).toFixed(1)}%`}
                    </td>
                    <td className="py-1 px-2 text-right font-mono text-ink-100">{e.revenueEstimate ? fmtBig(e.revenueEstimate) : '—'}</td>
                    <td className={`py-1 pl-2 text-right font-mono ${e.revenueGrowth > 0 ? 'text-emerald-400' : e.revenueGrowth < 0 ? 'text-red-400' : 'text-ink-400'}`}>
                      {e.revenueGrowth === null ? '—' : `${e.revenueGrowth >= 0 ? '+' : ''}${(e.revenueGrowth * 100).toFixed(1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
