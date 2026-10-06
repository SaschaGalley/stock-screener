import { useState } from 'react';
import { api } from '../../api';
import { useMoney } from '../../currency';
import { fmtPct, fmtSignedPct } from '../../format';
import { useArchive } from '../useArchive';
import type { Holder, Holders, InsiderTrade } from '../../../../src/analysis/holders';
import Term from '../Term';
import { useFirst } from '../More';

const pct = (v: number | null, d = 1) => fmtPct(v, d);

/**
 * Who holds the stock and who moved: the largest institutions and funds with
 * the change since their previous report, the insiders' own stakes, and every
 * insider trade on file — beside the summary figures above it.
 */
export default function HoldersPanel({ symbol }: { symbol: string }) {
  const { data, error } = useArchive(() => api.getHolders(symbol), [symbol]);
  if (error) return <p className="text-xs text-red-400">Nicht verfügbar: {error}</p>;
  if (data === undefined) return <p className="text-xs text-ink-500">Lade Aktionäre …</p>;
  if (data === null) return <p className="text-xs text-ink-500">Noch keine Halterdaten archiviert — sie kommen mit dem nächsten Refresh.</p>;
  return (
    <div className="space-y-4">
      <Breakdown h={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        <HolderTable title="Größte Institutionen" rows={data.institutions} />
        <HolderTable title="Größte Fonds" rows={data.funds} />
      </div>
      <Trades trades={data.trades} insiders={data} />
    </div>
  );
}

function Breakdown({ h }: { h: Holders }) {
  const { insiders, institutions, institutionsCount } = h.breakdown;
  if (insiders === null && institutions === null) return null;
  const ins = insiders ?? 0, inst = institutions ?? 0;
  const rest = Math.max(0, 1 - ins - inst);
  const n = h.netActivity;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-ink-800">
        <div className="bg-violet-500" style={{ width: `${ins * 100}%` }} title={`Insider ${pct(ins)}`} />
        <div className="bg-sky-500" style={{ width: `${inst * 100}%` }} title={`Institutionen ${pct(inst)}`} />
        <div className="bg-ink-600" style={{ width: `${rest * 100}%` }} title={`Übrige ${pct(rest)}`} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-400">
        <span><span className="text-violet-400">■</span> Insider {pct(insiders)}</span>
        <span><span className="text-sky-400">■</span> Institutionen {pct(institutions)}{institutionsCount ? ` · ${institutionsCount.toLocaleString('de-DE')} Halter` : ''}</span>
        <span><span className="text-ink-500">■</span> Übrige {pct(rest)}</span>
        {n && (n.buys !== null || n.sells !== null) && (
          <span title="Yahoos Zusammenfassung der letzten sechs Monate">
            Insider 6 M: {n.buys ?? 0} Käufe, {n.sells ?? 0} Verkäufe
            {n.netInstitutionalBuyingPercent !== null && <> · Institutionen netto {fmtSignedPct(n.netInstitutionalBuyingPercent, 1)}</>}
          </span>
        )}
      </div>
    </div>
  );
}

function HolderTable({ title, rows }: { title: string; rows: Holder[] }) {
  const { fmtBig } = useMoney();
  const [shown, more] = useFirst(rows, 8, 'Halter');
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-700 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-normal" />
            <th className="py-1 text-right font-normal"><Term k="concept.holders.share">Anteil</Term></th>
            <th className="py-1 text-right font-normal">Wert</th>
            <th className="py-1 text-right font-normal"><Term k="concept.holders.change">Veränderung</Term></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.organization} className="border-b border-ink-800" title={r.reportDate ? `Gemeldet zum ${r.reportDate}` : undefined}>
              <td className="max-w-[16rem] truncate py-1 pr-2 text-ink-300">{r.organization}</td>
              <td className="py-1 text-right font-mono text-ink-200">{pct(r.pctHeld, 2)}</td>
              <td className="py-1 text-right font-mono text-ink-400">{r.value === null ? '—' : fmtBig(r.value)}</td>
              <td className={`py-1 text-right font-mono ${r.pctChange === null ? 'text-ink-500' : r.pctChange > 0.005 ? 'text-emerald-400' : r.pctChange < -0.005 ? 'text-red-400' : 'text-ink-400'}`}>
                {fmtSignedPct(r.pctChange, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more}
    </div>
  );
}

function Trades({ trades, insiders }: { trades: InsiderTrade[]; insiders: Holders }) {
  const { fmtBig } = useMoney();
  const [all, setAll] = useState(false);
  const shown = trades.filter((t) => all || t.kind !== 'other');
  const hidden = trades.length - trades.filter((t) => t.kind !== 'other').length;
  if (trades.length === 0 && insiders.insiders.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-500"><Term k="concept.insiderTrades">Insider-Transaktionen</Term></h3>
        {hidden > 0 && (
          <button onClick={() => setAll((x) => !x)} className="text-xs text-ink-400 hover:text-ink-100">
            {all ? 'Nur Käufe und Verkäufe' : `+ ${hidden} Zuteilungen, Schenkungen, Ausübungen`}
          </button>
        )}
      </div>
      {shown.length === 0
        ? <p className="text-xs text-ink-500">Keine Käufe oder Verkäufe archiviert.</p>
        : (
          <table className="w-full text-xs tabular">
            <tbody>
              {shown.slice(0, 25).map((t, i) => (
                <tr key={i} className="border-b border-ink-800">
                  <td className="w-24 py-1 pr-2 font-mono text-ink-500">{t.tradedOn ?? '—'}</td>
                  <td className="py-1 pr-2 text-ink-300">{t.filer ?? '—'}<span className="text-ink-500">{t.relation ? ` · ${t.relation}` : ''}</span></td>
                  <td className={`py-1 pr-2 ${t.kind === 'sale' ? 'text-red-400' : t.kind === 'purchase' ? 'text-emerald-400' : 'text-ink-500'}`}>
                    {t.kind === 'sale' ? 'Verkauf' : t.kind === 'purchase' ? 'Kauf' : (t.description ?? 'Sonstiges')}
                  </td>
                  <td className="py-1 text-right font-mono text-ink-400">{t.shares === null ? '—' : Math.round(t.shares).toLocaleString('de-DE')}</td>
                  <td className="py-1 text-right font-mono text-ink-300">{t.value ? fmtBig(t.value) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}
