import type { ComputedMetrics, PeerMultiplesEntry } from '../../types';
import { fmtPrice, fmtSignedPct, mosColor, fmtPct, fmt } from '../../format';

interface Props {
  metrics: ComputedMetrics;
  price: number;
}

const METRIC_LABEL: Record<string, string> = {
  pe: 'P/E', evEbitda: 'EV/EBITDA', evRevenue: 'EV/Revenue',
  priceFCF: 'P/FCF', priceSales: 'P/S', pb: 'P/B',
};

export default function ValuationDetail({ metrics, price }: Props) {
  const { dcf, grahamNumber, grahamRevised, peterLynch, epv, ddm, rim, ncav, peerMultiples, reverseDCF } = metrics;

  const rows = [
    { label: `DCF (2-Stage, g=${(dcf.stage1Growth * 100).toFixed(1)}%)`, value: dcf.fairValue, note: dcf.fairValue ? `bear $${dcf.fairValueBear?.toFixed(2)} · bull $${dcf.fairValueBull?.toFixed(2)}` : dcf.assumptions },
    { label: 'Graham Number',           value: grahamNumber.grahamNumber, note: grahamNumber.grahamNumber === null ? 'requires +EPS & book value' : null },
    { label: 'Graham Revised V*',       value: grahamRevised.fairValue, note: grahamRevised.bondYield ? `AAA yield ${(grahamRevised.bondYield * 100).toFixed(1)}%` : null },
    { label: 'Peter Lynch',             value: peterLynch.fairValue, note: peterLynch.growthRate ? `g=${(peterLynch.growthRate * 100).toFixed(1)}%` : null },
    { label: 'EPV (Greenwald)',         value: epv.fairValue, note: epv.wacc ? `r=${(epv.wacc * 100).toFixed(1)}%` : null },
    { label: 'DDM (Gordon)',            value: ddm.isApplicable ? ddm.fairValue : null, note: ddm.isApplicable ? null : 'no dividend' },
    { label: 'Residual Income (RIM)',   value: rim.isApplicable ? rim.fairValue : null, note: rim.isApplicable ? `excess ${(rim.excessReturn * 100).toFixed(1)}pp` : 'no positive book/ROE' },
    { label: 'NCAV (Graham floor)',     value: ncav.isApplicable ? ncav.ncavPerShare : null, note: ncav.isApplicable ? null : 'CA ≤ liabilities' },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Single-equation models */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Single-Equation Models
        </h3>
        <table className="w-full text-xs tabular">
          <thead>
            <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
              <th className="py-1.5 pr-2 text-left font-medium">Model</th>
              <th className="py-1.5 px-2 text-right font-medium">Fair Value</th>
              <th className="py-1.5 pl-2 text-right font-medium">vs Price</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mos = r.value !== null ? (r.value - price) / price : null;
              return (
                <tr key={r.label} className="border-b border-ink-800">
                  <td className="py-1.5 pr-2 text-ink-200">
                    <div>{r.label}</div>
                    {r.note && <div className="text-[10px] text-ink-500">{r.note}</div>}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono text-ink-100">
                    {r.value !== null ? fmtPrice(r.value) : <span className="text-ink-600">—</span>}
                  </td>
                  <td className={`py-1.5 pl-2 text-right font-mono ${mosColor(mos)}`}>
                    {fmtSignedPct(mos)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {dcf.fairValue !== null && (
          <p className="mt-2 text-[10px] text-ink-500">
            DCF assumptions: {dcf.assumptions}
          </p>
        )}
      </div>

      {/* Peer multiples + reverse DCF */}
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Peer-Multiples Fair Value <span className="text-ink-600">({peerMultiples.count} multiples)</span>
          </h3>
          {peerMultiples.byMultiple.length > 0 ? (
            <table className="w-full text-xs tabular">
              <thead>
                <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="py-1.5 pr-2 text-left font-medium">Multiple</th>
                  <th className="py-1.5 px-2 text-right font-medium">Sector Median</th>
                  <th className="py-1.5 px-2 text-right font-medium">Implied Fair</th>
                  <th className="py-1.5 pl-2 text-right font-medium">vs Price</th>
                </tr>
              </thead>
              <tbody>
                {peerMultiples.byMultiple.map((e: PeerMultiplesEntry) => {
                  const mos = e.fairPrice !== null ? (e.fairPrice - price) / price : null;
                  return (
                    <tr key={e.metric} className="border-b border-ink-800">
                      <td className="py-1.5 pr-2 text-ink-200">{METRIC_LABEL[e.metric] ?? e.metric}</td>
                      <td className="py-1.5 px-2 text-right font-mono text-ink-300">
                        {e.sectorMedian !== null ? `${e.sectorMedian.toFixed(2)}x` : '—'}
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono text-ink-100">
                        {fmtPrice(e.fairPrice)}
                      </td>
                      <td className={`py-1.5 pl-2 text-right font-mono ${mosColor(mos)}`}>
                        {fmtSignedPct(mos)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-ink-700">
                  <td className="py-1.5 pr-2 text-[11px] font-medium text-ink-300">Median</td>
                  <td />
                  <td className="py-1.5 px-2 text-right font-mono font-semibold text-ink-50">
                    {fmtPrice(peerMultiples.medianFairPrice)}
                  </td>
                  <td className={`py-1.5 pl-2 text-right font-mono font-semibold ${mosColor(peerMultiples.marginOfSafety)}`}>
                    {fmtSignedPct(peerMultiples.marginOfSafety)}
                  </td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-ink-500">No peer-group data available.</p>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Reverse DCF
          </h3>
          {reverseDCF.isPossible && reverseDCF.impliedGrowthRate !== null ? (
            <div className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-400">Market implies stage-1 FCF growth of</span>
                <span className="font-mono text-lg font-semibold text-ink-50 tabular">
                  {(reverseDCF.impliedGrowthRate * 100).toFixed(1)}%/yr
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-ink-400">{reverseDCF.interpretation}</p>
            </div>
          ) : (
            <p className="text-xs text-ink-500">{reverseDCF.interpretation}</p>
          )}
        </div>
      </div>
    </div>
  );
}
