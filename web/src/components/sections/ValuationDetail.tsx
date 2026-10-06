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

/** A fair value against the price: a bar from the middle, longer the further off, and the gap in words. */
function VsPrice({ value, price, span }: { value: number | null; price: number; span: number }) {
  if (value === null) return <span className="text-ink-600">—</span>;
  const d = value / price - 1;
  const w = Math.min(50, (Math.abs(Math.log(1 + d)) / span) * 50);
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-24 shrink-0 rounded-full bg-ink-800">
        <div className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
        <div className={`absolute inset-y-0 rounded-full ${d >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
          style={d >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
      </div>
      <span className={`w-16 text-right font-mono text-xs ${mosColor(d)}`}>{fmtSignedPct(d, 0)}</span>
    </div>
  );
}

/**
 * Every model on its own, in two lists: those that work from the company's
 * own figures, and those that price it like its peers. Each says what it
 * rests on in words — "Wachstum 19,7 % (Konsens)" where it said "g=19,7 %",
 * the DCF's scenarios as a range where it said "p10 · p90 · 501 Ziehungen" —
 * and stands against the price as a bar.
 */
export default function ValuationDetail({ metrics, price }: Props) {
  const { fmtPrice } = useMoney();
  const { dcf, grahamNumber, grahamRevised, peterLynch, epv, ddm, rim, ncav, peerMultiples } = metrics;
  const p = (x: number | null | undefined) => fmtPct(x, 1);
  const dist = dcf.distribution;

  const rows: { label: string; term: GlossaryKey; value: number | null; note: string | null }[] = [
    {
      label: 'DCF, umsatzgetrieben', term: 'metrics.dcf.fairValue', value: dcf.fairValue,
      note: dcf.fairValue !== null && dist
        ? `Wachstum ${p(dcf.growthYear2)}; 80 % der Szenarien zwischen ${fmtPrice(dist.p10)} und ${fmtPrice(dist.p90)}, ${fmtPct(dist.probabilityAbovePrice, 0)} über dem Kurs`
        : dcf.assumptions,
    },
    { label: 'Peter Lynch', term: 'metrics.peterLynch.fairValue', value: peterLynch.fairValue,
      note: peterLynch.growthRate !== null ? `Gewinn mal Wachstum: ${p(peterLynch.growthRate)}${peterLynch.growthSource ? ` (${sourceLabel(peterLynch.growthSource)})` : ''}` : 'braucht Gewinn und 5–25 % Wachstum' },
    { label: 'Graham V* (revidiert)', term: 'metrics.grahamRevised.fairValue', value: grahamRevised.fairValue,
      note: grahamRevised.bondYield ? `Gewinn und Wachstum, gegen ${p(grahamRevised.bondYield)} Rendite erstklassiger Anleihen` : null },
    { label: 'EPV (Greenwald)', term: 'metrics.epv.fairValue', value: epv.fairValue,
      note: epv.normalizedMargin !== null ? `heutige Ertragskraft ohne Wachstum: Marge ${p(epv.normalizedMargin)}, Kapitalkosten ${p(epv.wacc)}` : null },
    { label: 'Excess Return (RIM)', term: 'metrics.rim.fairValue', value: rim.isApplicable ? rim.fairValue : null,
      note: rim.isApplicable ? `Eigenkapitalrendite ${p(rim.sustainableRoe)} → ${p(rim.terminalRoe)}, Kosten des Eigenkapitals ${p(rim.costOfEquity)}` : 'braucht positiven Buchwert und Eigenkapitalrendite' },
    { label: 'Dividendenmodell (DDM)', term: 'metrics.ddm.fairValue', value: ddm.isApplicable ? ddm.fairValue : null,
      note: ddm.isApplicable ? `Dividende wächst ${p(ddm.dividendGrowthRate)}, später ${p(ddm.terminalGrowthRate)}` : 'zahlt keine Dividende' },
    { label: 'Graham Number', term: 'metrics.grahamNumber.grahamNumber', value: grahamNumber.grahamNumber,
      note: grahamNumber.grahamNumber === null ? 'braucht positiven Gewinn und Buchwert' : 'aus Gewinn und Buchwert, ohne Wachstum' },
    { label: 'NCAV (Graham-Boden)', term: 'metrics.ncav.ncavPerShare', value: ncav.isApplicable ? ncav.ncavPerShare : null,
      note: ncav.isApplicable ? 'Umlaufvermögen abzüglich aller Schulden' : 'Umlaufvermögen deckt die Schulden nicht' },
  ];
  const values = [...rows.map((r) => r.value), ...peerMultiples.byMultiple.map((e: PeerMultiplesEntry) => e.fairPrice)]
    .filter((v): v is number => v !== null && v > 0);
  const span = Math.max(Math.log(2), ...values.map((v) => Math.abs(Math.log(v / price))));

  const Row = ({ label, term, note, value }: { label: React.ReactNode; term?: GlossaryKey; note: string | null; value: number | null }) => (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 py-2">
      <div className="min-w-0">
        <div className={`text-sm ${value === null ? 'text-ink-500' : 'text-ink-100'}`}>{term ? <Term k={term}>{label}</Term> : label}</div>
        {note && <div className="text-xs text-ink-500">{note}</div>}
      </div>
      <span className={`whitespace-nowrap text-right font-mono text-sm ${value === null ? 'text-ink-600' : 'text-ink-100'}`}>{value !== null ? fmtPrice(value) : '—'}</span>
      <VsPrice value={value} price={price} span={span} />
    </li>
  );

  return (
    <div className="grid gap-x-8 gap-y-6 xl:grid-cols-2">
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink-100"><Term k="concept.singleEquation">Aus den Zahlen der Firma</Term></h3>
        <p className="mb-1 text-xs text-ink-500">Jedes Modell eine Formel aus Gewinn, Umsatz, Buchwert oder Dividende.</p>
        <ul className="divide-y divide-ink-800">
          {rows.map((r) => <Row key={r.label} {...r} />)}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink-100">
          <Term k="metrics.peerMultiples.medianFairPrice">Wie die Peers bewertet</Term>
        </h3>
        <p className="mb-1 text-xs text-ink-500">Der Kurs, wenn die Börse die Firma so bewertete wie ihre {metrics.peerMultiples.peerCount ?? ''} Peers.</p>
        {peerMultiples.byMultiple.length > 0 ? (
          <ul className="divide-y divide-ink-800">
            {peerMultiples.byMultiple.map((e: PeerMultiplesEntry) => (
              <Row key={e.metric} label={<>nach {METRIC_LABEL[e.metric] ?? e.metric}</>} term={METRIC_TERM[e.metric]}
                note={e.sectorMedian !== null ? `die Peers zahlen das ${fmt(e.sectorMedian, '', 1)}-Fache` : null} value={e.fairPrice} />
            ))}
            <Row label={<span className="font-semibold">Mitte der Peer-Bewertungen</span>} note={null} value={peerMultiples.medianFairPrice} />
          </ul>
        ) : (
          <p className="text-sm text-ink-500">Keine Peer-Daten verfügbar.</p>
        )}
      </div>
    </div>
  );
}
