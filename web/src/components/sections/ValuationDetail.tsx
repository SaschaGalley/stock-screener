import type { ComputedMetrics, PeerMultiplesEntry } from '../../types';
import { fmtSignedPct, mosColor, fmt, fmtPct } from '../../format';
import { useMoney } from '../../currency';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  metrics: ComputedMetrics;
  price: number;
}

const METRIC_LABEL: Record<string, string> = {
  pe: 'P/E', evEbitda: 'EV/EBITDA', evRevenue: 'EV/Revenue',
  priceFCF: 'P/FCF', priceSales: 'P/S', pb: 'P/B',
};

/** The peer multiples by the keys `peerMultiples.byMultiple` carries. */
const METRIC_TERM: Record<string, GlossaryKey> = {
  pe: 'metrics.ratios.pe', evEbitda: 'metrics.evMultiples.evToEbitda', evRevenue: 'metrics.evMultiples.evToRevenue',
  priceFCF: 'metrics.evMultiples.priceToFCF', priceSales: 'metrics.evMultiples.priceToSales', pb: 'metrics.ratios.pb',
};

export default function ValuationDetail({ metrics, price }: Props) {
  const { fmtPrice, fmtBig } = useMoney();
  const { dcf, grahamNumber, grahamRevised, peterLynch, epv, ddm, rim, ncav, peerMultiples, reverseDCF } = metrics;
  const impliedMargin = reverseDCF.impliedMargin;

  // Build inline notes defensively — every property might be null/undefined
  // depending on whether a stock has the input data the model needs.
  const pctOf = (x: number | null | undefined) => (x !== null && x !== undefined && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
  const dist = dcf.distribution;
  const dcfNote = dcf.fairValue !== null && dist
    ? `p10 ${fmtPrice(dist.p10)} · p90 ${fmtPrice(dist.p90)} · ${(dist.probabilityAbovePrice * 100).toFixed(0)}% of ${dist.draws} draws above price`
    : dcf.assumptions;
  const grNote     = grahamRevised.bondYield ? `AAA yield ${(grahamRevised.bondYield * 100).toFixed(1)}%` : null;
  const lynchNote  = peterLynch.growthRate !== null ? `g=${pctOf(peterLynch.growthRate)}${peterLynch.growthSource ? ` (${peterLynch.growthSource})` : ''}` : null;
  const epvNote    = epv.normalizedMargin !== null ? `margin ${pctOf(epv.normalizedMargin)} · r=${pctOf(epv.wacc)}` : null;
  const rimNote    = rim.isApplicable
    ? `ROE ${pctOf(rim.sustainableRoe)} → ${pctOf(rim.terminalRoe)} vs ke ${pctOf(rim.costOfEquity)}`
    : 'no positive book/ROE';
  const ddmNote    = ddm.isApplicable ? `g=${pctOf(ddm.dividendGrowthRate)} → ${pctOf(ddm.terminalGrowthRate)}` : 'no dividend';

  const rows: { label: string; term: GlossaryKey; value: number | null; note: string | null }[] = [
    { label: `DCF (revenue-driven, g=${pctOf(dcf.growthYear2)})`, term: 'metrics.dcf.fairValue', value: dcf.fairValue, note: dcfNote },
    { label: 'Graham Number',       term: 'metrics.grahamNumber.grahamNumber', value: grahamNumber.grahamNumber, note: grahamNumber.grahamNumber === null ? 'requires +EPS & book value' : null },
    { label: 'Graham Revised V*',   term: 'metrics.grahamRevised.fairValue', value: grahamRevised.fairValue,   note: grNote },
    { label: 'Peter Lynch',         term: 'metrics.peterLynch.fairValue', value: peterLynch.fairValue,      note: lynchNote },
    { label: 'EPV (Greenwald)',     term: 'metrics.epv.fairValue', value: epv.fairValue,             note: epvNote },
    { label: 'DDM (two-stage)',     term: 'metrics.ddm.fairValue', value: ddm.isApplicable ? ddm.fairValue : null, note: ddmNote },
    { label: 'Excess Return (RIM)', term: 'metrics.rim.fairValue', value: rim.isApplicable ? rim.fairValue : null, note: rimNote },
    { label: 'NCAV (Graham floor)', term: 'metrics.ncav.ncavPerShare', value: ncav.isApplicable ? ncav.ncavPerShare : null, note: ncav.isApplicable ? null : 'CA ≤ liabilities' },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Single-equation models */}
      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          <Term k="concept.singleEquation">Single-Equation Models</Term>
        </h3>
        <table className="w-full text-xs tabular">
          <thead>
            <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
              <th className="py-1.5 pr-2 text-left font-medium">Model</th>
              <th className="py-1.5 px-2 text-right font-medium">Fair Value</th>
              <th className="py-1.5 pl-2 text-right font-medium"><Term k="concept.vsPrice">vs Price</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mos = r.value !== null ? (r.value - price) / price : null;
              return (
                <tr key={r.label} className="border-b border-ink-800">
                  <td className="py-1.5 pr-2 text-ink-200">
                    <div><Term k={r.term}>{r.label}</Term></div>
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
            <Term k="metrics.peerMultiples.medianFairPrice">Peer-Multiples Fair Value</Term> <span className="text-ink-600">({peerMultiples.count} multiples)</span>
          </h3>
          {peerMultiples.byMultiple.length > 0 ? (
            <table className="w-full text-xs tabular">
              <thead>
                <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="py-1.5 pr-2 text-left font-medium">Multiple</th>
                  <th className="py-1.5 px-2 text-right font-medium"><Term k="concept.sectorMedian">Sector Median</Term></th>
                  <th className="py-1.5 px-2 text-right font-medium"><Term k="concept.impliedFair">Implied Fair</Term></th>
                  <th className="py-1.5 pl-2 text-right font-medium"><Term k="concept.vsPrice">vs Price</Term></th>
                </tr>
              </thead>
              <tbody>
                {peerMultiples.byMultiple.map((e: PeerMultiplesEntry) => {
                  const mos = e.fairPrice !== null ? (e.fairPrice - price) / price : null;
                  return (
                    <tr key={e.metric} className="border-b border-ink-800">
                      <td className="py-1.5 pr-2 text-ink-200">
                        <Term k={METRIC_TERM[e.metric]}>{METRIC_LABEL[e.metric] ?? e.metric}</Term>
                      </td>
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
            <Term k="metrics.reverseDCF.impliedGrowthRate">Reverse DCF</Term>
          </h3>
          {reverseDCF.isPossible && reverseDCF.impliedGrowthRate !== null ? (
            <div className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-400">Market implies revenue growth (years 1–2) of</span>
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

        <div>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            <Term k="metrics.reverseDCF.impliedMargin.requiredMargin">Margin the price requires</Term>
          </h3>
          {impliedMargin ? (
            <div className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-400">Market implies a target operating margin of</span>
                <span className="font-mono text-lg font-semibold text-ink-50 tabular">
                  {fmtPct(impliedMargin.requiredMargin)}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-ink-400">
                {impliedMargin.interpretation}
                {impliedMargin.achievableMargin !== null && (
                  <> Best margin shown: {fmtPct(impliedMargin.achievableMargin)} ({impliedMargin.achievableBasis}).</>
                )}
              </p>
              <p className="mt-1 text-[10px] text-ink-500">
                On {fmtBig(impliedMargin.revenueBase)} trailing revenue growing {fmtPct(impliedMargin.revenueGrowth)}/yr
                ({impliedMargin.growthSource}), fading to terminal, at WACC {fmtPct(impliedMargin.discountRate)} —
                the forward DCF's own path, reinvestment and taxes, solved for the margin it settles at by year five.
              </p>
            </div>
          ) : (
            <p className="text-xs text-ink-500">Not calculable — requires revenue and a share count.</p>
          )}
        </div>
      </div>
    </div>
  );
}
