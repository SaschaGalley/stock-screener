import { useEffect, useState } from 'react';
import { api } from '../api';
import { recommendationColor } from '../format';
import { pct } from './evaluationParts';
import type { VerdictRecordSummary } from '../../../src/stock-history-service';
import { RECORD_HORIZONS, type LegStats, type VerdictRecord } from '../../../src/analysis/verdict-record';
import { recommendationTone } from '../../../src/verdict';

/**
 * Our verdicts as calls, the way the analysts' targets are judged on a stock
 * page: each change of verdict a dated statement, and how the stock then did
 * against the index. The rank IC beside it says whether the scores order the
 * stocks; this says what a reader who followed the labels would have got.
 */
export default function VerdictRecordPanel() {
  const [data, setData] = useState<VerdictRecordSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'all' | 'watchlist'>('all');

  useEffect(() => {
    api.getVerdictRecordSummary().then(setData).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="rounded border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-400">⚠ {error}</div>;
  if (!data) return <div className="p-8 text-center text-sm text-ink-500">Lade Urteile und Kurse…</div>;
  const r = scope === 'all' ? data.all : data.watchlist;

  return (
    <>
      <p className="text-sm leading-relaxed text-ink-300">
        Jeder Urteilswechsel als datierte Aussage — wie die Aktie danach gegen den S&amp;P 500 lief, mit Dividenden und in Dollar,
        nach einem, drei, sechs und zwölf Monaten und solange das Urteil galt. Ein Kaufurteil war richtig, wenn die Aktie den Index
        schlug, ein Verkaufsurteil, wenn sie ihm hinterherlief; Halten wird nur gemessen. Ein Wechsel zählt, sobald er die nächste
        Aktualisierung gehalten hat. Die Spalten füllen sich mit der Zeit: Ein Zwölf-Monats-Wert braucht ein Urteil, das ein Jahr alt ist.
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {([['all', `Alle Werte (${data.all.symbols})`], ['watchlist', `Watchlist (${data.watchlist.symbols})`]] as const).map(([s, label]) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`rounded px-2.5 py-1 text-xs transition ${
              s === scope ? 'bg-accent font-medium text-ink-950' : 'border border-ink-700 bg-ink-800 text-ink-300 hover:bg-ink-700'
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-2 text-[11px] text-ink-500">
          {r.calls} Urteile{r.from && ` seit ${r.from}`}
          {data.unpriced > 0 && ` · ${data.unpriced} Werte noch ohne archivierte Kurse`}
          {` · berechnet ${new Date(data.computedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`}
        </span>
      </div>

      {r.calls === 0
        ? <div className="p-6 text-center text-sm text-ink-500">Noch keine Urteile mit archivierten Kursen.</div>
        : <RecordTable r={r} />}
    </>
  );
}

/** Green where the typical call of this verdict was right: a buy above the index, a sell below it. */
function Cell({ s, verdict }: { s: LegStats; verdict: string }) {
  if (s.n === 0) return <td className="px-2 py-1.5 text-right text-ink-600">—</td>;
  const side = recommendationTone(verdict);
  const directional = side !== 'neutral';
  const right = s.medianExcess === null || !directional ? null : side === 'positive' ? s.medianExcess > 0 : s.medianExcess < 0;
  const tone = right === null ? 'text-ink-300' : right ? 'text-emerald-400' : 'text-red-400';
  return (
    <td className="px-2 py-1.5 text-right" title={`Mittelwert ${pct(s.meanExcess)} · ${s.n} Urteile`}>
      <span className={`font-mono ${tone}`}>{pct(s.medianExcess)}</span>
      {directional && s.hitRate !== null && (
        <span className="ml-1.5 font-mono text-[11px] text-ink-400">{Math.round(s.hitRate * 100)} %</span>
      )}
      <span className="ml-1 text-[10px] text-ink-600">{s.n}</span>
    </td>
  );
}

function RecordTable({ r }: { r: VerdictRecord }) {
  return (
    <section className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="text-[11px] text-ink-400">
          <tr className="border-b border-ink-800">
            <th className="px-4 py-1.5 text-left font-normal">Urteil</th>
            <th className="px-2 py-1.5 text-right font-normal">Urteile</th>
            {RECORD_HORIZONS.map((h) => <th key={h} className="px-2 py-1.5 text-right font-normal">{h} M</th>)}
            <th className="px-2 py-1.5 text-right font-normal">Solange es galt</th>
          </tr>
        </thead>
        <tbody>
          {r.byVerdict.map((v) => (
              <tr key={v.verdict} className="border-b border-ink-800/60">
                <td className="px-4 py-1.5">
                  <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${recommendationColor(v.verdict)}`}>{v.verdict}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-ink-400">{v.calls}</td>
                {RECORD_HORIZONS.map((h) => <Cell key={h} s={v.horizons[h]} verdict={v.verdict} />)}
                <Cell s={v.held} verdict={v.verdict} />
              </tr>
          ))}
          <tr className="bg-ink-950/40">
            <td className="px-4 py-1.5 text-xs text-ink-300" colSpan={2}>Kauf- und Verkaufsurteile zusammen: Trefferquote</td>
            {[...RECORD_HORIZONS.map((h) => r.directional[h]), r.directional.held].map((s, k) => (
              <td key={k} className="px-2 py-1.5 text-right font-mono text-ink-100">
                {s.hitRate === null ? '—' : `${Math.round(s.hitRate * 100)} %`}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="border-t border-ink-800 px-4 py-2 text-[11px] leading-relaxed text-ink-500">
        Je Zelle die mittlere (Median-)Mehrrendite gegenüber dem Index, bei Kauf und Verkauf dahinter der Anteil richtiger Urteile und
        klein die Zahl der Urteile, deren Zeitraum schon abgelaufen ist. Ein Verkaufsurteil mit negativer Mehrrendite war richtig.
      </p>
    </section>
  );
}
