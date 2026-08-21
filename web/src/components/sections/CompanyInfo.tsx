import { fmtCount } from '../../format';

interface Props {
  financials: any;
}

export default function CompanyInfo({ financials: f }: Props) {
  const items: { label: string; value: React.ReactNode }[] = [];

  if (f.headquarters) items.push({ label: 'Headquarters', value: f.headquarters });
  if (f.employees)    items.push({ label: 'Employees',    value: f.employees.toLocaleString() });
  if (f.website)      items.push({
    label: 'Website',
    value: <a href={f.website} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{f.website.replace(/^https?:\/\/(www\.)?/, '')}</a>,
  });
  if (f.isin) items.push({ label: 'ISIN', value: <span className="font-mono">{f.isin}</span> });
  if (f.wkn)  items.push({ label: 'WKN',  value: <span className="font-mono">{f.wkn}</span> });
  if (f.industry) items.push({ label: 'Industry', value: f.industry });
  if (f.sharesOutstanding) items.push({ label: 'Shares Outstanding', value: fmtCount(f.sharesOutstanding) });
  if (f.nextEarningsDate) items.push({ label: 'Next Earnings', value: f.nextEarningsDate });
  if (f.exDividendDate)   items.push({ label: 'Ex-Dividend',   value: f.exDividendDate });
  if (f.dividendPayDate)  items.push({ label: 'Pay Date',      value: f.dividendPayDate });

  return (
    <div className="space-y-4">
      {f.description && (
        <p className="text-xs leading-relaxed text-ink-300">
          {f.description}
        </p>
      )}
      {items.length > 0 && (
        <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {items.map((it) => (
            <div key={it.label} className="flex justify-between gap-2 border-b border-ink-800 py-1">
              <dt className="text-ink-500">{it.label}</dt>
              <dd className="text-right text-ink-200">{it.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
