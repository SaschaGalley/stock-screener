import { useEffect, useState } from 'react';
import { api } from '../api';
import Page, { HeaderButton } from '../components/Page';
import DepotCheck from '../components/DepotCheck';
import RecommendationBadge from '../components/RecommendationBadge';
import StockLogo, { initialsFromName } from '../components/StockLogo';
import { HEADER_HEIGHT, HEADER_RULE, ROW_HEIGHT, ROW_RULE } from '../components/StockRowCells';
import { scoreColor } from '../components/stockList';
import { evidenceLine, useVerdictEvidence } from '../components/VerdictEvidence';
import { fmtSignedPct } from '../format';
import type { DepotFlag, DepotPosition, DepotResponse, VerdictRecord } from '../../../src/analysis/depot';
import { RECOMMENDATIONS } from '../../../src/verdict';

const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} %`;
const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;

const TYPE_LABEL: Record<string, string> = {
  stock: 'Aktie', etf: 'ETF', bond: 'Anleihe', crypto: 'Krypto', future: 'Future', metal: 'Metall', metals: 'Metall',
};
/**
 * `ask` is something missing — a reason not written down, a stock outside the
 * watchlist — and reads as a note, not as a warning beside the ▼ and ▲ that
 * speak for holding less or more.
 */
const FLAG_TONE: Record<DepotFlag['tone'], string> = {
  reduce: 'text-red-400',
  add:    'text-emerald-400',
  ask:    'text-ink-500',
};
const FLAG_MARK: Record<DepotFlag['tone'], string> = { reduce: '▼', add: '▲', ask: '?' };
const openStock = (symbol: string) => { window.location.hash = `#/stock/${encodeURIComponent(symbol)}`; };

/**
 * The depot weighed against the model: every position with its weight, its
 * gain, the model's verdict and the reason in the journal, and what stands
 * out — concentrations, sell verdicts, missing reasons. Things to look at,
 * not orders: see `analysis/depot.ts` for why there are no target weights.
 */
export default function DepotPage() {
  const [data, setData] = useState<DepotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function load(sync: boolean) {
    setError(null);
    try {
      setData(await api.getDepot(sync));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void load(false); }, []);

  const view = data?.view ?? null;
  return (
    <Page
      title="Depot"
      subtitle={<>gegen das Modell{view && <> · <span className="font-mono text-ink-200">{eur(view.totalEur)}</span></>}</>}
      width="max-w-6xl"
      actions={data?.configured && (
        <HeaderButton
          onClick={async () => { setSyncing(true); await load(true); setSyncing(false); }}
          disabled={syncing}
          title={data.syncedAt ? `Zuletzt abgeglichen ${new Date(data.syncedAt).toLocaleString('de-DE')}` : undefined}
        >
          {syncing ? '⟳ gleiche ab …' : '↻ Mit umsatz abgleichen'}
        </HeaderButton>
      )}
    >
      {error && <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>}
      {!data && !error && <p className="p-8 text-center text-sm text-ink-500">Lese das Depot …</p>}
      {data && !data.configured && (
        <p className="text-sm text-ink-400">
          umsatz ist nicht verbunden. Mit <span className="font-mono">UMSATZ_API_KEY</span> (und in Produktion{' '}
          <span className="font-mono">UMSATZ_API_URL</span>) liest diese Seite die Trades und Kurse von dort.
        </p>
      )}
      {data?.syncError && <p className="text-xs text-amber-300">⚠ {data.syncError}</p>}
      {data?.configured && !view && !data.syncError && <p className="text-sm text-ink-500">Noch keine Trades aus umsatz.</p>}

      {view && (
        <>
          <section className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
            <h3 className="mb-1.5 text-xs font-semibold text-ink-300">Was auffällt</h3>
            <ul className="space-y-0.5 text-sm text-ink-200">
              {view.findings.map((f) => <li key={f}>{f}</li>)}
            </ul>
            <p className="mt-2 text-2xs text-ink-500">
              Keine Zielgewichte: Der Score hat als Portfolio-Regel den vorab festgelegten Test nicht bestanden. Die
              Hinweise sind Prüfpunkte — ▼ spricht dafür, weniger zu halten, ▲ für mehr, ? fehlt etwas —, keine Aufträge.
            </p>
          </section>

          <section className="overflow-x-auto rounded-lg border border-ink-800">
            <table className="w-full min-w-[56rem] border-collapse text-sm">
              <thead className="whitespace-nowrap bg-ink-900 text-2xs uppercase tracking-wider text-ink-500">
                <tr className={`${HEADER_HEIGHT} ${HEADER_RULE}`}>
                  <th className="px-3 py-0 text-left font-semibold">Position</th>
                  <th className="px-2 py-0 text-left font-semibold">Gewicht</th>
                  <th className="px-2 py-0 text-right font-semibold">Wert</th>
                  <th className="px-2 py-0 text-right font-semibold">seit Kauf</th>
                  <th className="px-2 py-0 text-right font-semibold">Score</th>
                  <th className="px-2 py-0 text-left font-semibold">Verdict</th>
                  <th className="px-2 py-0 text-left font-semibold">Begründung</th>
                  <th className="px-3 py-0 text-left font-semibold">Hinweise</th>
                </tr>
              </thead>
              <tbody>
                {view.positions.map((p) => <PositionRow key={p.isin} p={p} limit={view.limits.maxPosition} />)}
              </tbody>
            </table>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <Shares title="Aktien nach Sektor" rows={view.sectors.map((s) => ({ label: s.sector, weight: s.weight }))} limit={view.limits.maxSector} />
            <Shares title="Depot nach Anlageart" rows={view.byType.map((t) => ({ label: TYPE_LABEL[t.assetType] ?? t.assetType, weight: t.weight }))} />
          </div>

          <DepotCheck onOpen={openStock} />

          {data?.evidence && <Evidence records={data.evidence} />}
        </>
      )}
    </Page>
  );
}

/**
 * One position, in the overview's shape: logo and name over the ticker line,
 * score and verdict chip as the list shows them. A stock the model scores
 * opens its analysis; the rest have nothing to open.
 */
function PositionRow({ p, limit }: { p: DepotPosition; limit: number }) {
  const evidence = useVerdictEvidence();
  const open = p.symbol && p.tracked ? p.symbol : null;
  return (
    <tr
      onClick={open ? () => openStock(open) : undefined}
      title={p.isin}
      className={`${ROW_HEIGHT} ${ROW_RULE} ${open ? 'cursor-pointer transition hover:bg-ink-800' : ''}`}
    >
      <td className="min-w-[16rem] max-w-[22rem] py-1 pr-2 pl-3">
        <div className="flex min-w-0 items-center gap-2">
          <StockLogo symbol={p.symbol} domain={null} fallbackInitials={initialsFromName(p.name)} size={22} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-5 text-ink-100">{p.name}</div>
            <div className="truncate font-mono text-2xs leading-4 text-ink-500">
              {[p.symbol, TYPE_LABEL[p.assetType] ?? p.assetType, p.sector, `seit ${fmtDay(p.openedAt)}`].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
      </td>
      <td className="px-2 py-1">
        {p.weight !== null && (
          <div className="flex items-center gap-1.5">
            <div className="h-1.5 w-16 overflow-hidden rounded bg-ink-800">
              <div className={`h-full ${p.concentrated ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${Math.min(100, p.weight * 100 / (limit * 2))}%` }} />
            </div>
            <span className="whitespace-nowrap font-mono text-xs tabular text-ink-300">{pct(p.weight)}</span>
          </div>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular text-ink-200">{p.valueEur !== null ? eur(p.valueEur) : '—'}</td>
      <td className={`whitespace-nowrap px-2 py-1 text-right font-mono text-xs tabular ${p.gain === null ? 'text-ink-600' : p.gain >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
        {p.gain !== null ? fmtSignedPct(p.gain) : '—'}
      </td>
      <td className={`px-2 py-1 text-right font-mono text-base font-semibold tabular ${scoreColor(p.score)}`}>
        {p.score !== null ? p.score.toFixed(1) : <span className="text-sm font-normal text-ink-600">—</span>}
      </td>
      <td className="whitespace-nowrap px-2 py-1">
        {p.verdict
          ? <RecommendationBadge rec={p.verdict} size="sm" note={evidence ? evidenceLine(evidence, p.verdict) : null} />
          : <span className="text-xs text-ink-600">—</span>}
      </td>
      <td className="max-w-[14rem] px-2 py-1 text-xs">
        {p.reason
          ? (
            <a
              href="#/journal"
              onClick={(e) => e.stopPropagation()}
              className="line-clamp-2 leading-4 text-ink-300 hover:text-ink-100"
              title={`Journal, ${fmtDay(p.reason.day)}`}
            >
              {p.reason.headline}
            </a>
          )
          : <span className="text-ink-600">—</span>}
      </td>
      <td className="px-3 py-1 text-xs">
        <ul className="space-y-0.5 leading-4">
          {p.flags.map((f) => <li key={f.text} className={FLAG_TONE[f.tone]}>{FLAG_MARK[f.tone]} {f.text}</li>)}
        </ul>
      </td>
    </tr>
  );
}

function Shares({ title, rows, limit }: { title: string; rows: { label: string; weight: number }[]; limit?: number }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-lg border border-ink-800 px-4 py-3">
      <h3 className="mb-1.5 text-xs font-semibold text-ink-300">{title}</h3>
      <ul className="space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className="w-36 truncate text-ink-300">{r.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-ink-800">
              <div className={`h-full ${limit !== undefined && r.weight > limit ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${r.weight * 100}%` }} />
            </div>
            <span className="w-12 text-right font-mono text-ink-400">{pct(r.weight)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a verdict has been worth in the backtest: its return over the average
 * stock across the horizon, with its t. Shown beside the verdicts so a SELL
 * is read for what it has been — usually little.
 */
function Evidence({ records }: { records: VerdictRecord[] }) {
  const sorted = [...records].sort((a, b) =>
    RECOMMENDATIONS.indexOf(a.verdict as (typeof RECOMMENDATIONS)[number]) - RECOMMENDATIONS.indexOf(b.verdict as (typeof RECOMMENDATIONS)[number]));
  const horizon = records[0]?.horizon ?? 0;
  return (
    <section className="rounded-lg border border-ink-800 px-4 py-3">
      <h3 className="mb-1.5 text-xs font-semibold text-ink-300">Was ein Urteil im Backtest wert war</h3>
      <ul className="space-y-1 text-xs">
        {sorted.map((r) => (
          <li key={r.verdict} className="flex items-center gap-2">
            <span className="w-28"><RecommendationBadge rec={r.verdict} size="sm" /></span>
            <span className="w-16 text-right font-mono text-ink-200">{r.meanExcess !== null ? fmtSignedPct(r.meanExcess) : '—'}</span>
            <span className="font-mono text-ink-500">t {r.tStat !== null ? r.tStat.toFixed(1).replace('.', ',') : '—'}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-2xs text-ink-500">
        Mehrrendite gegenüber der durchschnittlichen Aktie über {horizon} {horizon === 1 ? 'Monat' : 'Monate'}. Ein t unter 2
        heißt: nicht von Zufall zu unterscheiden. Mehr auf der <a href="#/evaluation" className="text-accent hover:underline">Auswertung</a>.
      </p>
    </section>
  );
}
