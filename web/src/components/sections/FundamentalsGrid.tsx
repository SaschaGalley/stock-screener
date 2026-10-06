import { fmt, fmtPct, fmtSignedPct } from '../../format';
import { useMoney } from '../../currency';
import { SEASONAL_GAP_THRESHOLD } from '../../../../src/analysis/run-rate';
import Term from '../Term';
import type { GlossaryKey } from '../../glossary';

interface Props {
  financials: any;
  ratios: any;
  evMultiples: any;
}

export default function FundamentalsGrid({ financials: f, ratios, evMultiples: ev }: Props) {
  const { fmtBig } = useMoney();
  const seasonalGap: number | null = ev.seasonalGap ?? null;
  const seasonalWarning = seasonalGap !== null && Math.abs(seasonalGap) > SEASONAL_GAP_THRESHOLD
    ? ` Das einfache Run-Rate-KUV liegt ${fmtSignedPct(seasonalGap)} daneben: Das letzte Quartal war saisonal ${seasonalGap < 0 ? 'stark' : 'schwach'} oder hatte einen Sondereffekt, diese Zeile ist verlässlicher.`
    : '';
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Block title="Rentabilität">
        <Row label="Umsatz" term="financials.revenue"          value={fmtBig(f.revenue)} />
        <Row label="Umsatzwachstum" term="financials.revenueGrowth"   value={fmtPct(f.revenueGrowth)} accentByPct={f.revenueGrowth} />
        <Row label="Gewinnwachstum" term="financials.earningsGrowth"  value={fmtPct(f.earningsGrowth)} accentByPct={f.earningsGrowth} />
        <Row label="EPS-Wachstum 3 J." term="financials.epsGrowth3Y"    value={fmtPct(f.epsGrowth3Y)} accentByPct={f.epsGrowth3Y} />
        <Row label="Bruttogewinn" term="financials.grossProfit"     value={fmtBig(f.grossProfit)} />
        <Row label="EBITDA" term="financials.ebitda"           value={fmtBig(f.ebitda)} />
        <Row label="Free Cashflow" term="financials.freeCashFlow"   value={fmtBig(f.freeCashFlow)} />
        <Row label="Operative Marge" term="financials.operatingMargin" value={fmtPct(f.operatingMargin)} />
        <Row label="Nettomarge" term="financials.netMargin"       value={fmtPct(f.netMargin)} />
        <Row label="ROE" term="metrics.ratios.roe"              value={fmtPct(ratios.roe)} />
        <Row label="ROA" term="metrics.ratios.roa"              value={fmtPct(ratios.roa)} />
        <Row label="ROIC" term="financials.roic"             value={fmtPct(f.roic)} />
        {ratios.ownerEarningsYield !== null && (
          <Row label="Owner-Earnings-Rendite" term="metrics.ratios.ownerEarningsYield" value={fmtPct(ratios.ownerEarningsYield)} accentByPct={ratios.ownerEarningsYield} />
        )}
      </Block>

      <Block title="Bilanz & Liquidität">
        <Row label="Liquide Mittel" term="financials.totalCash"      value={fmtBig(f.totalCash)} />
        <Row label="Schulden gesamt" term="financials.totalDebt"      value={fmtBig(f.totalDebt)} />
        <Row label="Langfristige Schulden" term="financials.longTermDebt"  value={fmtBig(f.longTermDebt)} />
        <Row label="Working Capital" term="financials.workingCapital" value={fmtBig(f.workingCapital)} />
        <Row label="Current Ratio" term="financials.currentRatio"   value={fmt(f.currentRatio, 'x')} />
        <Row label="Quick Ratio" term="financials.quickRatio"     value={fmt(f.quickRatio, 'x')} />
        <Row label="Schulden / Eigenkapital" term="financials.debtToEquity"   value={fmt(f.debtToEquity, 'x')} />
        <Row label="Bilanzsumme" term="financials.totalAssets"    value={fmtBig(f.totalAssets)} />
        <Row label="Verbindlichkeiten gesamt" term="financials.totalLiabilities" value={fmtBig(f.totalLiabilities)} />
        <Row label="Gewinnrücklagen" term="financials.retainedEarnings" value={fmtBig(f.retainedEarnings)} />
      </Block>

      <Block title="Bewertungsmultiples">
        <Row label="KGV TTM" term="metrics.ratios.pe"       value={fmt(ratios.pe, 'x')} />
        <Row label="Forward-KGV" term="metrics.ratios.forwardPE"   value={fmt(ratios.forwardPE, 'x')} />
        <Row label="Ø-KGV (5 J.)" term="financials.avgPE5Y"  value={fmt(f.avgPE5Y, 'x')} />
        <Row label="PEG" term="metrics.ratios.peg"           value={fmt(ratios.peg)} />
        <Row label="KBV" term="metrics.ratios.pb"           value={fmt(ratios.pb, 'x')} />
        <Row label="KUV TTM" term="metrics.evMultiples.priceToSales"       value={fmt(ev.priceToSales, 'x')} />
        <Row label="Forward-KUV" term="metrics.evMultiples.forwardPriceToSales"   value={fmt(ev.forwardPriceToSales, 'x')} />
        <Row
          label="Run-Rate-KUV" term="metrics.evMultiples.simpleValuationRatio"
          value={fmt(ev.simpleValuationRatio, 'x')}
          hint={ev.latestQuarterEndDate ? `Hier mit dem Umsatz aus ${formatQEnd(ev.latestQuarterEndDate)}.` : undefined}
        />
        <Row
          label="Run-Rate-KUV (saisonbereinigt)" term="metrics.evMultiples.seasonallyAdjustedValuationRatio"
          value={fmt(ev.seasonallyAdjustedValuationRatio, 'x')}
          warn={seasonalWarning !== ''}
          hint={`Wachstumsrate des jüngsten Quartals: ${fmtSignedPct(ev.latestQuarterYoYGrowth)}.${seasonalWarning}`}
        />
        <Row label="EV/EBITDA" term="metrics.evMultiples.evToEbitda"     value={fmt(ev.evToEbitda, 'x')} />
        <Row label="EV/Umsatz" term="metrics.evMultiples.evToRevenue"    value={fmt(ev.evToRevenue, 'x')} />
        <Row label="EV/FCF" term="metrics.evMultiples.evToFCF"        value={fmt(ev.evToFCF, 'x')} />
        <Row label="P/FCF" term="metrics.evMultiples.priceToFCF"         value={fmt(ev.priceToFCF, 'x')} />
        <Row label="Dividendenrendite" term="metrics.ratios.dividendYield" value={fmtPct(f.dividendYield)} />
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">{title}</h3>
      <table className="w-full text-xs tabular">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  term,
  value,
  accentByPct,
  hint,
  warn,
}: {
  label: string;
  term?: GlossaryKey;
  value: string;
  accentByPct?: number | null;
  /** What this stock's figure adds to the glossary's explanation. */
  hint?: string;
  /** Amber value — the figure is fine, but read the hint before trusting its neighbour. */
  warn?: boolean;
}) {
  let valueColor = warn ? 'text-amber-400' : 'text-ink-100';
  if (accentByPct !== undefined && accentByPct !== null && Number.isFinite(accentByPct)) {
    valueColor = accentByPct > 0 ? 'text-emerald-400' : accentByPct < 0 ? 'text-red-400' : 'text-ink-100';
  }
  return (
    <tr className="border-b border-ink-800">
      <td className="py-1 pr-2 text-ink-400">
        <Term k={term} extra={hint}>{label}</Term>
      </td>
      <td className={`py-1 text-right font-mono ${valueColor}`}>{value}</td>
    </tr>
  );
}

/** Format a YYYY-MM-DD quarter end into a short fiscal label like "Q1'26". */
function formatQEnd(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const m = d.getMonth() + 1;
  const q = m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4';
  const yy = String(d.getFullYear()).slice(-2);
  return `${q}'${yy}`;
}
