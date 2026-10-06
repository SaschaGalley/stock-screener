import { useState } from 'react';
import { fmtCount } from '../../format';

interface Props {
  financials: any;
}

const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

/**
 * What the company does, at the top of its overview: the description in
 * three lines with the rest on request, and the facts a reader looks up —
 * where it sits, how many people, the identifiers, the next dates — in one
 * line under it. It used to be a folded section of its own at the end of the
 * figures, the last place anyone looks for what a company is.
 */
export default function CompanyInfo({ financials: f }: Props) {
  const [open, setOpen] = useState(false);
  const facts: { label: string; value: React.ReactNode }[] = [];
  if (f.industry)     facts.push({ label: 'Branche', value: f.industry });
  if (f.headquarters) facts.push({ label: 'Sitz', value: f.headquarters });
  if (f.employees)    facts.push({ label: 'Mitarbeiter', value: f.employees.toLocaleString('de-DE') });
  if (f.website)      facts.push({
    label: 'Website',
    value: <a href={f.website} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{f.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a>,
  });
  if (f.isin) facts.push({ label: 'ISIN', value: <span className="font-mono">{f.isin}</span> });
  if (f.wkn)  facts.push({ label: 'WKN',  value: <span className="font-mono">{f.wkn}</span> });
  if (f.sharesOutstanding) facts.push({ label: 'Aktien', value: fmtCount(f.sharesOutstanding) });
  if (f.nextEarningsDate) facts.push({ label: 'Nächste Zahlen', value: dayDe(f.nextEarningsDate) });
  if (f.exDividendDate)   facts.push({ label: 'Ex-Dividende', value: dayDe(f.exDividendDate) });

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-900 p-4">
      <h3 className="text-[15px] font-semibold text-ink-50">Über das Unternehmen</h3>
      {f.description && (
        <div className="mt-2">
          <p className={`text-sm leading-relaxed text-ink-300 ${open ? '' : 'line-clamp-3'}`}>{f.description}</p>
          {f.description.length > 320 && (
            <button onClick={() => setOpen((o) => !o)} className="mt-1 text-xs text-ink-400 hover:text-ink-100">
              {open ? 'weniger' : 'weiterlesen'}
            </button>
          )}
        </div>
      )}
      {facts.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {facts.map((it) => (
            <div key={it.label} className="min-w-0">
              <dt className="text-xs text-ink-500">{it.label}</dt>
              <dd className="truncate text-ink-200">{it.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
