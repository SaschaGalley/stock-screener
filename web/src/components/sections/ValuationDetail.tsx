import type { ComputedMetrics, PeerMultiplesEntry } from '../../types';
import { deNumber, fmtSignedPct, mosColor, fmt, fmtPct } from '../../format';
import { useMoney } from '../../currency';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  metrics: ComputedMetrics;
  price: number;
}

const METRIC_LABEL: Record<string, string> = {
  pe: 'KGV', evEbitda: 'EV/EBITDA', evRevenue: 'EV/Umsatz',
  priceFCF: 'P/FCF', priceSales: 'KUV', pb: 'KBV',
};

/** The models' English source enums, as the page reads them. */
const SOURCE_LABEL: Record<string, string> = {
  consensus: 'Konsens', '3y CAGR': 'CAGR 3 J.',
  'analyst consensus': 'Analystenkonsens', 'trailing twelve months': 'letzte zwölf Monate', 'steady state': 'langfristiges Wachstum',
  current: 'heute', history: 'eigene Historie', peers: 'Peers',
};
const sourceLabel = (s: string | null | undefined) => (s ? SOURCE_LABEL[s] ?? s : s);

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
  const pctOf = (x: number | null | undefined) => fmtPct(x, 1);
  const dist = dcf.distribution;
  const dcfNote = dcf.fairValue !== null && dist
    ? `p10 ${fmtPrice(dist.p10)} · p90 ${fmtPrice(dist.p90)} · ${fmtPct(dist.probabilityAbovePrice, 0)} von ${deNumber(dist.draws, 0)} Ziehungen über dem Kurs`
    : dcf.assumptions;
  const grNote     = grahamRevised.bondYield ? `AAA-Rendite ${fmtPct(grahamRevised.bondYield, 1)}` : null;
  const lynchNote  = peterLynch.growthRate !== null ? `g=${pctOf(peterLynch.growthRate)}${peterLynch.growthSource ? ` (${sourceLabel(peterLynch.growthSource)})` : ''}` : null;
  const epvNote    = epv.normalizedMargin !== null ? `Marge ${pctOf(epv.normalizedMargin)} · r=${pctOf(epv.wacc)}` : null;
  const rimNote    = rim.isApplicable
    ? `ROE ${pctOf(rim.sustainableRoe)} → ${pctOf(rim.terminalRoe)} gegen ke ${pctOf(rim.costOfEquity)}`
    : 'kein positiver Buchwert/ROE';
  const ddmNote    = ddm.isApplicable ? `g=${pctOf(ddm.dividendGrowthRate)} → ${pctOf(ddm.terminalGrowthRate)}` : 'keine Dividende';

  const rows: { label: string; term: GlossaryKey; value: number | null; note: string | null }[] = [
    { label: `DCF (umsatzgetrieben, g=${pctOf(dcf.growthYear2)})`, term: 'metrics.dcf.fairValue', value: dcf.fairValue, note: dcfNote },
    { label: 'Graham Number',       term: 'metrics.grahamNumber.grahamNumber', value: grahamNumber.grahamNumber, note: grahamNumber.grahamNumber === null ? 'braucht positiven Gewinn und Buchwert' : null },
    { label: 'Graham V* (revidiert)', term: 'metrics.grahamRevised.fairValue', value: grahamRevised.fairValue,   note: grNote },
    { label: 'Peter Lynch',         term: 'metrics.peterLynch.fairValue', value: peterLynch.fairValue,      note: lynchNote },
    { label: 'EPV (Greenwald)',     term: 'metrics.epv.fairValue', value: epv.fairValue,             note: epvNote },
    { label: 'DDM (zweistufig)',     term: 'metrics.ddm.fairValue', value: ddm.isApplicable ? ddm.fairValue : null, note: ddmNote },
    { label: 'Excess Return (RIM)', term: 'metrics.rim.fairValue', value: rim.isApplicable ? rim.fairValue : null, note: rimNote },
    { label: 'NCAV (Graham-Boden)',  term: 'metrics.ncav.ncavPerShare', value: ncav.isApplicable ? ncav.ncavPerShare : null, note: ncav.isApplicable ? null : 'Umlaufvermögen ≤ Verbindlichkeiten' },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Single-equation models */}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-ink-300">
          <Term k="concept.singleEquation">Formelmodelle</Term>
        </h3>
        <table className="w-full text-xs tabular">
          <thead>
            <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
              <th className="py-1.5 pr-2 text-left font-medium">Modell</th>
              <th className="py-1.5 px-2 text-right font-medium">Fairer Wert</th>
              <th className="py-1.5 pl-2 text-right font-medium"><Term k="concept.vsPrice">zum Kurs</Term></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mos = r.value !== null ? (r.value - price) / price : null;
              return (
                <tr key={r.label} className="border-b border-ink-800">
                  <td className="py-1.5 pr-2 text-ink-200">
                    <div><Term k={r.term}>{r.label}</Term></div>
                    {r.note && <div className="text-2xs text-ink-500">{r.note}</div>}
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
          <p className="mt-2 text-xs text-ink-500">
            DCF-Annahmen: {dcf.assumptions}
          </p>
        )}
      </div>

      {/* Peer multiples + reverse DCF */}
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 text-xs font-semibold text-ink-300">
            <Term k="metrics.peerMultiples.medianFairPrice">Fairer Wert nach Peer-Multiples</Term> <span className="text-ink-500">({peerMultiples.count} Multiples)</span>
          </h3>
          {peerMultiples.byMultiple.length > 0 ? (
            <table className="w-full text-xs tabular">
              <thead>
                <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
                  <th className="py-1.5 pr-2 text-left font-medium">Multiple</th>
                  <th className="py-1.5 px-2 text-right font-medium"><Term k="concept.sectorMedian">Sektormedian</Term></th>
                  <th className="py-1.5 px-2 text-right font-medium"><Term k="concept.impliedFair">Fairer Kurs</Term></th>
                  <th className="py-1.5 pl-2 text-right font-medium"><Term k="concept.vsPrice">zum Kurs</Term></th>
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
                        {fmt(e.sectorMedian, 'x', 2)}
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
                  <td className="py-1.5 pr-2 text-xs font-medium text-ink-300">Median</td>
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
            <p className="text-xs text-ink-500">Keine Peer-Daten verfügbar.</p>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-ink-300">
            <Term k="metrics.reverseDCF.impliedGrowthRate">Reverse DCF</Term>
          </h3>
          {reverseDCF.isPossible && reverseDCF.impliedGrowthRate !== null ? (
            <div className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-400">Der Kurs unterstellt ein Umsatzwachstum (Jahr 1–2) von</span>
                <span className="font-mono text-lg font-semibold text-ink-50 tabular">
                  {fmtPct(reverseDCF.impliedGrowthRate, 1)}/Jahr
                </span>
              </div>
              <p className="mt-1.5 text-xs text-ink-400">{reverseDCF.interpretation}</p>
            </div>
          ) : (
            <p className="text-xs text-ink-500">{reverseDCF.interpretation}</p>
          )}
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold text-ink-300">
            <Term k="metrics.reverseDCF.impliedMargin.requiredMargin">Marge, die der Kurs verlangt</Term>
          </h3>
          {impliedMargin ? (
            <div className="rounded border border-ink-800 bg-ink-950 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-ink-400">Der Kurs unterstellt eine operative Zielmarge von</span>
                <span className="font-mono text-lg font-semibold text-ink-50 tabular">
                  {fmtPct(impliedMargin.requiredMargin)}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-ink-400">
                {impliedMargin.interpretation}
                {impliedMargin.achievableMargin !== null && (
                  <> Beste bisher gezeigte Marge: {fmtPct(impliedMargin.achievableMargin)} ({sourceLabel(impliedMargin.achievableBasis)}).</>
                )}
              </p>
              <p className="mt-1 text-xs text-ink-500">
                Ausgehend von {fmtBig(impliedMargin.revenueBase)} Umsatz der letzten zwölf Monate, der um {fmtPct(impliedMargin.revenueGrowth)}/Jahr
                wächst ({sourceLabel(impliedMargin.growthSource)}) und dann zum langfristigen Wachstum ausläuft, bei WACC {fmtPct(impliedMargin.discountRate)} —
                mit Pfad, Reinvestitionen und Steuern des DCF, gelöst nach der Marge, bei der er bis Jahr fünf ankommt.
              </p>
            </div>
          ) : (
            <p className="text-xs text-ink-500">Nicht berechenbar — braucht Umsatz und Aktienzahl.</p>
          )}
        </div>
      </div>
    </div>
  );
}
