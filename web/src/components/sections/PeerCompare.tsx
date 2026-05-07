import { fmt, fmtPct } from '../../format';

interface Props {
  ratios: any;
  evMultiples: any;
  financials: any;
  sectorMedians: any;
}

interface RowSpec {
  label: string;
  value: number | null;
  median: number | null;
  lowerIsBetter: boolean;
  isPercent?: boolean;
}

export default function PeerCompare({ ratios, evMultiples: ev, financials: f, sectorMedians: sm }: Props) {
  if (!sm) {
    return <p className="text-xs text-ink-500">No peer data available — Finnhub couldn't return a peer set.</p>;
  }

  const peerNames = (sm.peers ?? []).slice(0, 6).join(', ') + (sm.peers && sm.peers.length > 6 ? '…' : '');

  const rows: RowSpec[] = [
    { label: 'P/E',            value: ratios.pe,                    median: sm.pe,                  lowerIsBetter: true  },
    { label: 'EV/EBITDA',      value: ev.evToEbitda,                median: sm.evToEbitda,          lowerIsBetter: true  },
    { label: 'EV/Revenue',     value: ev.evToRevenue,               median: sm.evToRevenue,         lowerIsBetter: true  },
    { label: 'P/S (TTM)',      value: ev.priceToSales,              median: sm.priceToSales,        lowerIsBetter: true  },
    { label: 'Forward P/S',    value: ev.forwardPriceToSales,       median: sm.forwardPriceToSales, lowerIsBetter: true  },
    { label: 'P/FCF',          value: ev.priceToFCF,                median: sm.priceToFCF,          lowerIsBetter: true  },
    { label: 'P/B',            value: ratios.pb,                    median: sm.pb,                  lowerIsBetter: true  },
    { label: 'Operating Margin', value: f.operatingMargin,          median: sm.operatingMargin,     lowerIsBetter: false, isPercent: true },
    { label: 'Net Margin',     value: f.netMargin,                  median: sm.netMargin,           lowerIsBetter: false, isPercent: true },
    { label: 'ROE',            value: f.roe,                        median: sm.roe,                 lowerIsBetter: false, isPercent: true },
    { label: 'ROIC',           value: f.roic,                       median: sm.roic,                lowerIsBetter: false, isPercent: true },
    { label: 'Revenue Growth', value: f.revenueGrowth,              median: sm.revenueGrowthYoY,    lowerIsBetter: false, isPercent: true },
  ];

  return (
    <div>
      <p className="mb-2 text-[11px] text-ink-500">
        {sm.peerCount} peers: {peerNames}
      </p>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
            <th className="py-1.5 pr-2 text-left font-medium">Metric</th>
            <th className="py-1.5 px-2 text-right font-medium">Own</th>
            <th className="py-1.5 px-2 text-right font-medium">Peer Median</th>
            <th className="py-1.5 pl-2 text-right font-medium">Δ vs Peer</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.value !== null && r.median !== null && r.median !== 0
              ? ((r.value - r.median) / Math.abs(r.median)) * 100
              : null;
            const isGood = pct !== null && (r.lowerIsBetter ? pct < -10 : pct > 10);
            const isBad  = pct !== null && (r.lowerIsBetter ? pct > 30  : pct < -20);
            const color = pct === null ? 'text-ink-500' : isGood ? 'text-emerald-400' : isBad ? 'text-red-400' : 'text-amber-400';
            const fmtVal = (v: number | null) => v === null ? '—' : r.isPercent ? fmtPct(v) : fmt(v, 'x', 1);
            return (
              <tr key={r.label} className="border-b border-ink-800/60">
                <td className="py-1.5 pr-2 text-ink-300">{r.label}</td>
                <td className="py-1.5 px-2 text-right font-mono text-ink-100">{fmtVal(r.value)}</td>
                <td className="py-1.5 px-2 text-right font-mono text-ink-400">{fmtVal(r.median)}</td>
                <td className={`py-1.5 pl-2 text-right font-mono ${color}`}>
                  {pct === null ? '—' : `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
