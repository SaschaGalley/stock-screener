import { fmt, fmtPct, fmtPercentPoints } from '../../format';
import Term from '../Term';
import { GLOSSARY, type GlossaryKey } from '../../glossary';

interface Props {
  ratios: any;
  evMultiples: any;
  financials: any;
  sectorMedians: any;
}

interface RowSpec {
  label: string;
  term: GlossaryKey;
  value: number | null;
  median: number | null;
  lowerIsBetter: boolean;
  isPercent?: boolean;
  hint?: string;
}

export default function PeerCompare({ ratios, evMultiples: ev, financials: f, sectorMedians: sm }: Props) {
  if (!sm) {
    return <p className="text-xs text-ink-500">Keine Peer-Daten verfügbar — Finnhub hat keine Vergleichsgruppe geliefert.</p>;
  }

  const peerNames = (sm.peers ?? []).slice(0, 6).join(', ') + (sm.peers && sm.peers.length > 6 ? '…' : '');

  const rows: RowSpec[] = [
    { label: 'KGV', term: 'metrics.ratios.pe',            value: ratios.pe,                    median: sm.pe,                  lowerIsBetter: true  },
    { label: 'EV/EBITDA', term: 'metrics.evMultiples.evToEbitda',      value: ev.evToEbitda,                median: sm.evToEbitda,          lowerIsBetter: true  },
    { label: 'EV/Umsatz', term: 'metrics.evMultiples.evToRevenue',     value: ev.evToRevenue,               median: sm.evToRevenue,         lowerIsBetter: true  },
    { label: 'KUV (TTM)', term: 'metrics.evMultiples.priceToSales',      value: ev.priceToSales,              median: sm.priceToSales,        lowerIsBetter: true  },
    {
      label: 'Run-Rate-KUV',
      term: 'metrics.evMultiples.simpleValuationRatio',
      value: ev.simpleValuationRatio,
      median: sm.runRatePriceToSales ?? null,  // absent from analyses cached before the field existed
      lowerIsBetter: true,
      hint: GLOSSARY['peers.runRatePriceToSales'],
    },
    {
      label: 'Run-Rate-KUV (saisonbereinigt)',
      term: 'metrics.evMultiples.seasonallyAdjustedValuationRatio',
      value: ev.seasonallyAdjustedValuationRatio ?? null,
      median: sm.runRatePriceToSales ?? null,
      lowerIsBetter: true,
      hint: GLOSSARY['peers.runRatePriceToSales'],
    },
    { label: 'Forward-KUV', term: 'metrics.evMultiples.forwardPriceToSales',    value: ev.forwardPriceToSales,       median: sm.forwardPriceToSales, lowerIsBetter: true  },
    { label: 'P/FCF', term: 'metrics.evMultiples.priceToFCF',          value: ev.priceToFCF,                median: sm.priceToFCF,          lowerIsBetter: true  },
    { label: 'KBV', term: 'metrics.ratios.pb',            value: ratios.pb,                    median: sm.pb,                  lowerIsBetter: true  },
    { label: 'Operative Marge', term: 'financials.operatingMargin', value: f.operatingMargin,          median: sm.operatingMargin,     lowerIsBetter: false, isPercent: true },
    { label: 'Nettomarge', term: 'financials.netMargin',     value: f.netMargin,                  median: sm.netMargin,           lowerIsBetter: false, isPercent: true },
    { label: 'ROE', term: 'metrics.ratios.roe',            value: f.roe,                        median: sm.roe,                 lowerIsBetter: false, isPercent: true },
    { label: 'ROIC', term: 'financials.roic',           value: f.roic,                       median: sm.roic,                lowerIsBetter: false, isPercent: true },
    { label: 'Umsatzwachstum', term: 'financials.revenueGrowth', value: f.revenueGrowth,              median: sm.revenueGrowthYoY,    lowerIsBetter: false, isPercent: true },
  ];

  const multiples = rows.filter((r) => r.lowerIsBetter);
  const quality = rows.filter((r) => !r.lowerIsBetter);
  const cheaper = multiples.filter((r) => verdictOf(r)?.good === true).length;
  const dearer = multiples.filter((r) => verdictOf(r)?.good === false).length;
  const better = quality.filter((r) => verdictOf(r)?.good === true).length;
  const worse = quality.filter((r) => verdictOf(r)?.good === false).length;

  return (
    <div className="space-y-5">
      <p className="text-xs text-ink-500">{sm.peerCount} Peers: {peerNames}</p>
      <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
        <Group
          title="Teurer oder günstiger bewertet?"
          answer={cheaper > dearer ? `Günstiger bei ${cheaper} von ${multiples.length} Kennzahlen` : dearer > cheaper ? `Teurer bei ${dearer} von ${multiples.length} Kennzahlen` : 'Etwa gleich bewertet'}
          tone={cheaper > dearer ? 'text-emerald-400' : dearer > cheaper ? 'text-red-400' : 'text-ink-200'}
          rows={multiples}
        />
        <Group
          title="Besser oder schlechter im Geschäft?"
          answer={better > worse ? `Besser bei ${better} von ${quality.length} Kennzahlen` : worse > better ? `Schlechter bei ${worse} von ${quality.length} Kennzahlen` : 'Etwa gleichauf'}
          tone={better > worse ? 'text-emerald-400' : worse > better ? 'text-red-400' : 'text-ink-200'}
          rows={quality}
        />
      </div>
    </div>
  );
}

/** Within this share of the peers' median a figure is level with them. */
const LEVEL = 0.1;

/** How a figure stands against the peers, in words: "45 % günstiger", "+33,7 Pp. höher". */
function verdictOf(r: RowSpec): { text: string; good: boolean | null } | null {
  if (r.value === null || r.median === null || r.median === 0) return null;
  if (r.isPercent) {
    const d = r.value - r.median;
    if (Math.abs(d) < 0.01) return { text: 'gleichauf', good: null };
    return { text: `${fmtPercentPoints(d * 100, 1).replace('%', 'Pp.')} ${d > 0 ? 'höher' : 'niedriger'}`, good: d > 0 };
  }
  if (r.value <= 0 || r.median <= 0) return null;
  const ratio = r.value / r.median;
  if (Math.abs(ratio - 1) < LEVEL) return { text: 'gleichauf', good: null };
  return ratio < 1
    ? { text: `${Math.round((1 - ratio) * 100)} % günstiger`, good: true }
    : { text: ratio >= 2 ? `${fmt(ratio, '', 1)}-mal so teuer` : `${Math.round((ratio - 1) * 100)} % teurer`, good: false };
}

function Group({ title, answer, tone, rows }: { title: string; answer: string; tone: string; rows: RowSpec[] }) {
  const fmtVal = (r: RowSpec, v: number | null) => (v === null ? '—' : r.isPercent ? fmtPct(v) : fmt(v, 'x', 1));
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink-100">{title}</h3>
      <p className={`mb-2 text-sm ${tone}`}>{answer}</p>
      <table className="w-full text-sm tabular">
        <thead>
          <tr className="border-b border-ink-800 text-xs text-ink-500">
            <th className="py-1 pr-2 text-left font-normal" />
            <th className="py-1 px-2 text-right font-normal">Aktie</th>
            <th className="py-1 px-2 text-right font-normal">Peers</th>
            <th className="py-1 pl-2 text-right font-normal" />
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">
          {rows.map((r) => {
            const v = verdictOf(r);
            return (
              <tr key={r.label}>
                <td className="py-1.5 pr-2 text-ink-300"><Term k={r.term} extra={r.hint}>{r.label}</Term></td>
                <td className="py-1.5 px-2 text-right font-mono text-ink-100">{fmtVal(r, r.value)}</td>
                <td className="py-1.5 px-2 text-right font-mono text-ink-400">{fmtVal(r, r.median)}</td>
                <td className={`whitespace-nowrap py-1.5 pl-2 text-right ${v?.good === true ? 'text-emerald-400' : v?.good === false ? 'text-red-400' : 'text-ink-500'}`}>
                  {v?.text ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
