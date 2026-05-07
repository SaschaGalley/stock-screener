import type { StockSummary } from '../types';
import { fmtBig, fmtPrice, fmt, relativeTime } from '../format';
import { api } from '../api';

interface Props {
  summary: StockSummary;
  financials: any;
}

export default function StockHeader({ summary, financials: f }: Props) {
  const logoUrl = summary.logoDomain
    ? `https://www.google.com/s2/favicons?domain=${summary.logoDomain}&sz=128`
    : null;

  return (
    <header className="shrink-0 border-b border-ink-800 bg-ink-900 px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-10 w-10 rounded bg-white p-1" onError={(e) => (e.currentTarget.style.display = 'none')} />
          ) : null}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-ink-50">{summary.companyName}</h1>
              <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-xs text-ink-300">{summary.symbol}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-3 text-xs text-ink-400">
              {summary.sector && <span>{summary.sector}</span>}
              {summary.industry && summary.industry !== summary.sector && <span>· {summary.industry}</span>}
              {f.headquarters && <span>· {f.headquarters}</span>}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href={api.reportPdfUrl(summary.symbol)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700"
            title="Download PDF report"
          >
            PDF
          </a>
          <a
            href={api.reportMarkdownUrl(summary.symbol)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-ink-700 bg-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 transition hover:bg-ink-700"
            title="View Markdown"
          >
            MD
          </a>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KV label="Price"            value={fmtPrice(f.price)} bigValue />
        <KV label="Market Cap"       value={fmtBig(f.marketCap)} />
        <KV label="Enterprise Value" value={fmtBig(f.enterpriseValue)} />
        <KV label="52W Range"        value={`${fmtPrice(f.fiftyTwoWeekLow)} – ${fmtPrice(f.fiftyTwoWeekHigh)}`} />
        <KV label="Beta"             value={fmt(f.beta)} subtle={summary.cachedAt ? `cached ${relativeTime(summary.cachedAt)}` : ''} />
      </div>
    </header>
  );
}

function KV({ label, value, bigValue, subtle }: { label: string; value: string; bigValue?: boolean; subtle?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`font-mono tabular ${bigValue ? 'text-lg font-bold text-ink-50' : 'text-sm text-ink-100'}`}>
        {value}
      </div>
      {subtle && <div className="text-[10px] text-ink-600">{subtle}</div>}
    </div>
  );
}
