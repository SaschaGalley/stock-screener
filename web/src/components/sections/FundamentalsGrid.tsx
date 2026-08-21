import { fmt, fmtPct } from '../../format';
import { useMoney } from '../../currency';

interface Props {
  financials: any;
  ratios: any;
  evMultiples: any;
}

export default function FundamentalsGrid({ financials: f, ratios, evMultiples: ev }: Props) {
  const { fmtBig } = useMoney();
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Block title="Profitability">
        <Row label="Revenue"          value={fmtBig(f.revenue)} />
        <Row label="Revenue Growth"   value={fmtPct(f.revenueGrowth)} accentByPct={f.revenueGrowth} />
        <Row label="Earnings Growth"  value={fmtPct(f.earningsGrowth)} accentByPct={f.earningsGrowth} />
        <Row label="EPS Growth 3Y"    value={fmtPct(f.epsGrowth3Y)} accentByPct={f.epsGrowth3Y} />
        <Row label="Gross Profit"     value={fmtBig(f.grossProfit)} />
        <Row label="EBITDA"           value={fmtBig(f.ebitda)} />
        <Row label="Free Cash Flow"   value={fmtBig(f.freeCashFlow)} />
        <Row label="Operating Margin" value={fmtPct(f.operatingMargin)} />
        <Row label="Net Margin"       value={fmtPct(f.netMargin)} />
        <Row label="ROE"              value={fmtPct(ratios.roe)} />
        <Row label="ROA"              value={fmtPct(ratios.roa)} />
        <Row label="ROIC"             value={fmtPct(f.roic)} />
        {ratios.ownerEarningsYield !== null && (
          <Row label="Owner Earnings Yield" value={fmtPct(ratios.ownerEarningsYield)} accentByPct={ratios.ownerEarningsYield} />
        )}
      </Block>

      <Block title="Balance Sheet & Liquidity">
        <Row label="Total Cash"      value={fmtBig(f.totalCash)} />
        <Row label="Total Debt"      value={fmtBig(f.totalDebt)} />
        <Row label="Long-term Debt"  value={fmtBig(f.longTermDebt)} />
        <Row label="Working Capital" value={fmtBig(f.workingCapital)} />
        <Row label="Current Ratio"   value={fmt(f.currentRatio, 'x')} />
        <Row label="Quick Ratio"     value={fmt(f.quickRatio, 'x')} />
        <Row label="Debt / Equity"   value={fmt(f.debtToEquity, 'x')} />
        <Row label="Total Assets"    value={fmtBig(f.totalAssets)} />
        <Row label="Total Liabilities" value={fmtBig(f.totalLiabilities)} />
        <Row label="Retained Earnings" value={fmtBig(f.retainedEarnings)} />
      </Block>

      <Block title="Valuation Multiples">
        <Row label="P/E TTM"       value={fmt(ratios.pe, 'x')} />
        <Row label="Forward P/E"   value={fmt(ratios.forwardPE, 'x')} />
        <Row label="Avg P/E (5Y)"  value={fmt(f.avgPE5Y, 'x')} />
        <Row label="PEG"           value={fmt(ratios.peg)} />
        <Row label="P/B"           value={fmt(ratios.pb, 'x')} />
        <Row label="P/S TTM"       value={fmt(ev.priceToSales, 'x')} />
        <Row label="Forward P/S"   value={fmt(ev.forwardPriceToSales, 'x')} />
        <Row
          label="P/S Run-Rate"
          value={fmt(ev.simpleValuationRatio, 'x')}
          hint={
            ev.latestQuarterEndDate
              ? `Market cap ÷ (${formatQEnd(ev.latestQuarterEndDate)} revenue × 4). Run-rate P/S — reacts to the latest quarter, not the trailing 12-month average. Caveat: noisy for highly seasonal businesses.`
              : 'Market cap ÷ (latest quarter revenue × 4). Run-rate P/S — reacts to the latest quarter, not the trailing 12-month average.'
          }
        />
        <Row label="EV/EBITDA"     value={fmt(ev.evToEbitda, 'x')} />
        <Row label="EV/Revenue"    value={fmt(ev.evToRevenue, 'x')} />
        <Row label="EV/FCF"        value={fmt(ev.evToFCF, 'x')} />
        <Row label="P/FCF"         value={fmt(ev.priceToFCF, 'x')} />
        <Row label="Dividend Yield" value={fmtPct(f.dividendYield)} />
      </Block>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      <table className="w-full text-xs tabular">
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  value,
  accentByPct,
  hint,
}: {
  label: string;
  value: string;
  accentByPct?: number | null;
  hint?: string;
}) {
  let valueColor = 'text-ink-100';
  if (accentByPct !== undefined && accentByPct !== null && Number.isFinite(accentByPct)) {
    valueColor = accentByPct > 0 ? 'text-emerald-400' : accentByPct < 0 ? 'text-red-400' : 'text-ink-100';
  }
  return (
    <tr className="border-b border-ink-800" title={hint}>
      <td className="py-1 pr-2 text-ink-400">
        {label}
        {hint && <span className="ml-1 cursor-help text-ink-600">ⓘ</span>}
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
