import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import RecommendationBadge from './RecommendationBadge';
import StockLogo, { initialsFromName } from './StockLogo';
import Tip from './Tip';
import { scoreColor } from './stockList';
import { deNumber, fmtPrice, fmtSignedPct } from '../format';
import type { DepotCheckResponse } from '../../../src/api-types';
import {
  shareWords, stepSize, type CheckedStock, type DepotCheckResult, type DepotNote, type ManagerAction, type ManagerMove,
  type ProtectionChoice, type StopEvidence,
} from '../../../src/analysis/depot-check';
import { SECTOR_DIRECTION_LABEL, type MarketBrief, type SectorDirection } from '../../../src/analysis/market-brief';
import { GROUP_SIDE, type DepotCheckHistory, type RecordGroup } from '../../../src/analysis/depot-check-record';
import type { SectorPhase, SectorTrend } from '../../../src/analysis/sector-rotation';
import type { Protection } from '../../../src/analysis/stops';
import { MODELS } from '../../../src/models';

const eur = (n: number) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const fmtTime = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const fmtDay = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(0, 4)}`;
const pct = (x: number) => `${deNumber(x * 100, 1)} %`;
const score = (x: number) => deNumber(x, 1);
const TREND: Record<'up' | 'down' | 'sideways', { mark: string; label: string; cls: string }> = {
  up:       { mark: '↗', label: 'Chart steigt', cls: 'text-emerald-400' },
  down:     { mark: '↘', label: 'Chart fällt', cls: 'text-red-400' },
  sideways: { mark: '→', label: 'Chart seitwärts', cls: 'text-ink-400' },
};
const ACTION: Record<ManagerAction, string> = {
  kaufen: 'text-emerald-400', aufstocken: 'text-emerald-400', halten: 'text-ink-300',
  'gewinne mitnehmen': 'text-amber-300', reduzieren: 'text-red-400', verkaufen: 'text-red-400', beobachten: 'text-sky-300',
};
const PHASE: Record<SectorPhase, string> = {
  'führt': 'text-emerald-400', 'verliert Schwung': 'text-amber-300', 'hinkt': 'text-red-400', 'holt auf': 'text-sky-300',
};
const DIRECTION: Record<SectorDirection, string> = {
  'strong': 'text-emerald-400', 'turning-up': 'text-sky-300', 'turning-down': 'text-amber-300', 'weak': 'text-red-400',
};

/**
 * The depot check on the depot page: one button, and what came of the last
 * run. Answer first — what a depot manager would do, then each stock held
 * with its step and where the chart would protect it, then what to look at
 * buying — and the market it was all read against last. Possibilities, said
 * as such.
 */
export default function DepotCheck({ onOpen, sectors, totalEur, cashEur, held }: {
  onOpen: (symbol: string) => void;
  /** The depot's sector weights among its stocks, to set beside the sectors' trends. */
  sectors: { sector: string; weight: number }[];
  /** Today's depot value: the manager's target weights become euros here, never in the prompt. */
  totalEur: number;
  /** Money ready to invest, as entered. */
  cashEur: number | null;
  /** Today's positions by ticker: the steps become shares and euros here, never in the prompt. */
  held: Map<string, Held>;
}) {
  const [data, setData] = useState<DepotCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.getDepotCheck().then(setData).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const running = data?.status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(reload, 5_000);
    return () => window.clearInterval(t);
  }, [running, reload]);

  async function run() {
    setError(null);
    try {
      const r = await api.runDepotCheck();
      if (!r.started) setError(r.reason ?? 'Depot-Check nicht gestartet.');
    } catch (e) {
      setError((e as Error).message);
    }
    reload();
  }

  const s = data?.settings;
  const st = data?.status ?? null;
  const r = data?.result ?? null;
  const [notes, setNotes] = useState<Record<string, DepotNote>>({});
  useEffect(() => { if (data) setNotes(data.notes); }, [data]);

  async function askAgain() {
    setError(null);
    try {
      const res = await api.askDepotManager();
      if (!res.started) setError(res.reason ?? 'Nicht gestartet.');
    } catch (e) {
      setError((e as Error).message);
    }
    reload();
  }

  return (
    <section className="rounded-lg border border-ink-800 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink-100">Depot-Check</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
            {s
              ? <>Analysiert die bis zu {s.maxCandidates} besten Aktien außerhalb des Depots ab Score {score(s.minScore)} — aus der
                Liste und dem Universum — samt Chart, liest die Charts aller Aktien im Depot und rechnet ihre Stops,
                {s.marketModel ? ' holt die Marktlage von Perplexity' : ''} und fragt dann ein Modell, was ein Depotmanager tun
                würde. Möglichkeiten zum Prüfen, keine Anlageberatung.</>
              : 'Lädt …'}
          </p>
        </div>
        <button
          onClick={() => void run()}
          disabled={running || !data}
          className="shrink-0 rounded bg-accent px-3 py-1.5 text-sm font-medium text-ink-950 transition hover:bg-accent-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? 'Prüft …' : 'Depot prüfen'}
        </button>
      </div>

      <Cash initial={cashEur} totalEur={totalEur} />

      {error && <p className="mt-2 text-xs text-red-400">⚠ {error}</p>}
      {st && running && (
        <p className="mt-2 text-xs text-amber-300">
          Läuft seit {fmtTime(st.startedAt)}{st.total > 0 && <> · {st.done}/{st.total}</>}{st.phase && <> · {st.phase}</>}
          {st.total > 0 && (
            <span className="mt-1 block h-1 w-full overflow-hidden rounded bg-ink-800">
              <span className="block h-full bg-amber-400 transition-all" style={{ width: `${(st.done / st.total) * 100}%` }} />
            </span>
          )}
        </p>
      )}
      {st && (st.state === 'failed' || st.state === 'interrupted') && (
        <p className="mt-2 text-xs text-red-400">
          {st.state === 'interrupted' ? 'Abgebrochen' : 'Fehlgeschlagen'}{st.finishedAt && ` ${fmtTime(st.finishedAt)}`}{st.error && ` — ${st.error}`}
        </p>
      )}

      {r && (
        <Result
          r={r} onOpen={onOpen} sectors={sectors} changes={data?.history?.changes ?? []} totalEur={totalEur} held={held}
          notes={notes} onNotes={setNotes} onAskAgain={running ? null : () => void askAgain()}
          evidence={data?.stopEvidence ?? null} eurPer={data?.eurPer ?? {}}
        />
      )}
      {data?.history && <History h={data.history} onOpen={onOpen} />}
    </section>
  );
}

function Result({ r, onOpen, sectors, changes, totalEur, held, notes, onNotes, onAskAgain, evidence, eurPer }: {
  r: DepotCheckResult; onOpen: (symbol: string) => void; sectors: { sector: string; weight: number }[];
  changes: DepotCheckHistory['changes']; totalEur: number; held: Map<string, Held>;
  notes: Record<string, DepotNote>; onNotes: (notes: Record<string, DepotNote>) => void;
  /** Null while a run is going. */
  onAskAgain: (() => void) | null;
  evidence: StopEvidence | null;
  /** Euros per unit of a quote currency, for the levels in euros beside the stock's own. */
  eurPer: Record<string, number>;
}) {
  // Notes written or changed since the manager last answered.
  const answered = r.notes ?? {};
  const unanswered = [...new Set([...Object.keys(notes), ...Object.keys(answered)])]
    .filter((k) => (notes[k]?.text ?? '') !== (answered[k] ?? ''));
  const moves = new Map((r.manager?.moves ?? []).map((m) => [m.symbol, m]));
  const order = new Map((r.manager?.moves ?? []).map((m, i) => [m.symbol, i]));
  const holdings = [...r.holdings].sort((a, b) =>
    (order.get(a.symbol) ?? Infinity) - (order.get(b.symbol) ?? Infinity) || (b.weight ?? 0) - (a.weight ?? 0));
  const reduce = new Set(r.lists.reduce.map((c) => c.symbol));
  const failed = r.candidates.filter((c) => c.error);
  const name = (c: CheckedStock) => c.name ?? c.symbol;
  // Results before 8.10.2026 read only the weak stocks held.
  const allHeld = r.holdings.some((h) => h.protection !== undefined);

  return (
    <div className="mt-3 space-y-5 border-t border-ink-800 pt-3">
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h4 className="text-xs font-semibold text-ink-300">Was ein Depotmanager tun würde</h4>
          {r.managerAt && r.managerAt !== r.generatedAt && <span className="text-2xs text-ink-500">neu gefragt {fmtTime(r.managerAt)}</span>}
          <Tip content="Fragt nur den Depotmanager neu: mit den Analysen, Charts und der Marktlage dieses Checks, dem heutigen Depot und deinen Notizen. Ein Modellaufruf, kein ganzer Check.">
            <button
              onClick={onAskAgain ?? undefined}
              disabled={!onAskAgain}
              className={`rounded border px-2 py-0.5 text-2xs transition disabled:opacity-40 ${
                unanswered.length ? 'border-accent text-accent hover:bg-accent hover:text-ink-950' : 'border-ink-700 text-ink-300 hover:border-ink-500'
              }`}
            >
              Depotmanager neu fragen{unanswered.length ? ` · ${unanswered.length} ${unanswered.length === 1 ? 'Notiz' : 'Notizen'} neu` : ''}
            </button>
          </Tip>
        </div>
        {r.manager
          ? <p className="text-sm leading-relaxed text-ink-100">{r.manager.summary}</p>
          : <p className="text-xs text-ink-500">Kein Text{r.managerError ? `: ${r.managerError}` : '.'}</p>}
        {changes.length > 0 && (
          <p className="mt-1.5 text-xs leading-relaxed text-ink-400">
            <span className="text-ink-500">Seit dem letzten Check: </span>
            {changes.map((c, i) => (
              <span key={c.symbol}>
                {i > 0 && ' · '}
                <button onClick={() => onOpen(c.symbol)} className="text-ink-200 hover:text-ink-50">{c.name ?? c.symbol}</button>{' '}
                {c.from ? <span className={ACTION[c.from]}>{c.from}</span> : 'neu'} → {c.to ? <span className={ACTION[c.to]}>{c.to}</span> : 'nicht mehr genannt'}
              </span>
            ))}
          </p>
        )}
      </div>

      {holdings.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-300">
            <Tip content={`Jede Aktie im Depot mit dem Schritt und dem Schutz, die der Depotmanager wählt, und seiner Begründung. Stückzahlen, Beträge, Stop-Marke und Trailing-Abstand rechnet die App selbst, aus deinem Depot und dem Chart; das Modell sieht keine Stückzahl. Rot markiert: Score unter ${score(r.settings.reduceBelow)} und der Chart fällt.`}>
              <span>{allHeld ? 'Deine Aktien' : `Depotwerte unter ${score(r.settings.reduceBelow)}`}</span>
            </Tip>
          </h4>
          <ul className="divide-y divide-ink-800/70">
            {holdings.map((h) => (
              <HoldingRow
                key={h.symbol} h={h} move={moves.get(h.symbol) ?? null} weak={reduce.has(h.symbol)} onOpen={onOpen}
                totalEur={totalEur} now={held.get(h.symbol) ?? null}
                note={notes[h.symbol] ?? null} answered={answered[h.symbol] ?? null} onNotes={onNotes}
                evidence={evidence} eurPer={eurPer}
              />
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <List
          title="Kaufen ansehen" tone="text-emerald-400" rows={r.lists.buy} moves={moves} onOpen={onOpen} totalEur={totalEur}
          empty={`Keine Aktie hält ${score(r.settings.minScore)} nach der Analyse und hat einen steigenden Chart.`}
          hint="Außerhalb des Depots: Score nach der Analyse noch über der Schwelle, Urteil BUY oder STRONG BUY, Chart steigt."
        />
        <List
          title="Hoch bewertet, Chart noch nicht" tone="text-ink-200" rows={r.lists.waitForChart} moves={moves} onOpen={onOpen} totalEur={totalEur}
          hint="Score hält, aber der Chart steigt nicht — oder das Urteil wurde zurückgehalten."
        />
      </div>

      {(r.lists.dropped.length > 0 || failed.length > 0) && (
        <p className="text-xs text-ink-500">
          {r.lists.dropped.length > 0 && (
            <>Nach der Analyse unter {score(r.settings.minScore)}: {r.lists.dropped.map((c) => `${name(c)} (${c.score === null ? '—' : score(c.score)})`).join(', ')}. </>
          )}
          {failed.length > 0 && (
            <Tip content={failed.map((c) => `${c.symbol}: ${c.error}`).join('\n')}>
              <span className="underline decoration-dotted">Bei {failed.length} ging etwas schief.</span>
            </Tip>
          )}
        </p>
      )}

      {r.manager && r.manager.risks.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-300">Was er im Blick behält</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-ink-300">
            {r.manager.risks.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
      )}

      {(r.market || r.marketError || (r.sectorTrends?.length ?? 0) > 0) && (
        <Market brief={r.market ?? null} error={r.marketError ?? null} trends={r.sectorTrends ?? []} sectors={sectors} />
      )}

      <p className="text-2xs leading-relaxed text-ink-500">
        Geprüft {fmtTime(r.generatedAt)} mit {modelsUsed(r)} · {r.candidates.length} Kandidaten ab {score(r.settings.minScore)},{' '}
        {r.holdings.length} Aktien im Depot. Das Modell bekommt je Position Name, Anlageart und Gewicht, bei Aktien dazu
        Sektor, „seit Kauf“ in Prozent, Haltedauer in Monaten, das Ergebnis des Thesen-Checks, Score, Chart und die Abstände
        zu Stop und Trailing, deine Notiz, die Käufe und Verkäufe der Position (Tag, Kurs, Umfang in Prozent) mit deinen
        Begründungen aus dem Journal, seinen eigenen letzten Vorschlag zur Aktie, dazu das verfügbare Geld als Anteil am Depot — keine Stückzahlen, Beträge oder Gebühren
        und nichts aus deinen Konten. Perplexity bekommt nur die Frage nach dem Markt. Stops begrenzen Verluste, sie bringen keine
        Rendite; was sie im Backtest kosteten und schützten, steht beim Schutz unter „Backtest“ und auf der Auswertung. Keine Anlageberatung.
      </p>
    </div>
  );
}

/** Which model did what: one name where one did everything, else each with its task. */
function modelsUsed(r: DepotCheckResult): string {
  const name = (id: string) => MODELS.find((m) => m.id === id)?.label ?? id;
  const chart = r.chartModel ?? r.model;
  const manager = r.managerModel ?? r.model;
  return chart === r.model && manager === r.model
    ? name(r.model)
    : `${name(r.model)} (Analysen), ${name(chart)} (Charts), ${name(manager)} (Depotmanager)`;
}

/** A position as the depot holds it today: what a step's size is counted in. */
export interface Held { quantity: number; valueEur: number | null }

/** Shares as the position counts them: whole where it holds whole shares, else to the hundredth. */
const qty = (n: number, whole = false) => deNumber(whole ? Math.round(n) : n, whole || Number.isInteger(n) ? 0 : 2).replace(/,00$/, '');
/** Whole euros: the count is whole shares, so the sum is too, give or take the day's price. */
const roundEur = (n: number) => eur(Math.round(n));

/**
 * A stock held: what it is and where the investor stands with it on the
 * first line, labelled; then the manager's step said as what to do — how
 * many shares, how many euros, worked out here from today's position — the
 * protection said as an order to place, and the manager's reason.
 */
function HoldingRow({ h, move, weak, onOpen, totalEur, now, note, answered, onNotes, evidence, eurPer }: {
  h: CheckedStock; move: ManagerMove | null; weak: boolean; onOpen: (symbol: string) => void;
  totalEur: number; now: Held | null;
  /** The owner's note as it stands, and as the manager read it. */
  note: DepotNote | null; answered: string | null; onNotes: (notes: Record<string, DepotNote>) => void;
  evidence: StopEvidence | null;
  eurPer: Record<string, number>;
}) {
  const t = h.chart ? TREND[h.chart.trend] : null;
  const p = h.protection ?? null;
  // The rate on file, else the position's own: its euro price in the depot over the chart's close.
  const rate = !p?.currency ? null : eurPer[p.currency]
    ?? (now?.valueEur && now.quantity > 0 && p.close > 0 ? now.valueEur / now.quantity / p.close : null);
  const label = 'text-2xs text-ink-500';
  return (
    <li className={`py-2.5 ${weak ? 'border-l-2 border-red-500/60 pl-2' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <button onClick={() => onOpen(h.symbol)} className="flex min-w-0 flex-1 basis-56 items-center gap-2 self-center text-left">
          <StockLogo symbol={h.symbol} domain={null} fallbackInitials={initialsFromName(h.name ?? h.symbol)} size={18} />
          <span className="truncate text-sm text-ink-100 hover:text-ink-50">
            {h.name ?? h.symbol} <span className="font-mono text-2xs text-ink-500">{h.symbol}</span>
          </span>
        </button>
        <span className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tabular">
          {h.weight !== null && <span className="text-ink-300">{pct(h.weight)} <span className={label}>des Depots</span></span>}
          <span className={h.gain == null ? 'text-ink-600' : h.gain >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {h.gain == null ? '—' : fmtSignedPct(h.gain)} <span className={label}>seit Kauf</span>
          </span>
          <span>
            <span className={label}>Score </span>
            <span className={`text-sm font-semibold ${h.score === null ? 'text-ink-500' : scoreColor(h.score)}`}>{h.score === null ? '—' : score(h.score)}</span>
          </span>
          {t && (
            <Tip focusable={false} content={chartTip(h, t.label)}>
              <span className={t.cls}>{t.mark} <span className={label}>{t.label}</span></span>
            </Tip>
          )}
          {p?.rsi != null && (p.rsi >= 70 || p.rsi <= 30) && (
            <Tip focusable={false} content={p.rsi >= 70 ? 'RSI über 70: heiß gelaufen' : 'RSI unter 30: ausverkauft'}>
              <span className={p.rsi >= 70 ? 'text-amber-300' : 'text-sky-300'}>RSI {Math.round(p.rsi)}</span>
            </Tip>
          )}
        </span>
      </div>
      {move && (
        <dl className="mt-1.5 grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-0.5 text-xs leading-relaxed">
          <dt className={`font-semibold uppercase tracking-wide ${ACTION[move.action]}`}>{move.action}</dt>
          <dd className="text-ink-100">{stepWords(move, h, now, totalEur) ?? <span className="text-ink-400">nichts verändern</span>}</dd>
          {p && move.protect && (
            <>
              <dt className="text-ink-500">{move.action === 'verkaufen' ? 'bis zum Verkauf' : 'Schutz'}</dt>
              <dd>
                <ProtectionWords p={p} choice={move.protect} own={move.stopPrice ?? null} rate={rate} />
                {move.protect !== 'keiner' && <EvidenceNote evidence={evidence} rule={move.protect} />}
              </dd>
            </>
          )}
          <dt className="text-ink-500">warum</dt>
          <dd className="text-ink-300">{move.reason}</dd>
        </dl>
      )}
      <Note symbol={h.symbol} note={note} changed={(note?.text ?? '') !== (answered ?? '')} onNotes={onNotes} />
      {move?.noteReply && answered && (
        <div className="mt-0.5 grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs leading-relaxed">
          <span className="text-ink-500">Antwort</span>
          <span className="text-ink-200">{move.noteReply}</span>
        </div>
      )}
      {h.error && !h.chart && <p className="mt-0.5 text-2xs text-ink-500">{h.error}</p>}
    </li>
  );
}

/**
 * The step as what to do: how much of the position, in shares and euros, and
 * the weight that leaves (`stepSize`) — the manager's target beside it where
 * whole shares land off it.
 */
function stepWords(move: ManagerMove, h: CheckedStock | null, now: Held | null, totalEur: number): ReactNode {
  const size = stepSize(move.targetPct, h?.weight ?? null, now, totalEur);
  if (!size || move.targetPct == null) return null;
  const before = h?.weight ?? 0;
  const target = move.targetPct / 100;
  const off = Math.abs(size.after - target) >= 0.0005;
  const span = (
    <span className="text-ink-500">
      {' '}· {before > 0 ? `${pct(before)} → ` : ''}{pct(size.after)} des Depots{off && ` (Ziel ${pct(target)}, auf ganze Stück gerundet)`}
    </span>
  );
  if (size.shares === 0) {
    return <><span className="text-ink-400">Weniger als ein Stück — nichts zu tun</span><span className="text-ink-500"> · Ziel {pct(target)} des Depots</span></>;
  }
  if (size.kind === 'sell') {
    const words = shareWords(size.fraction);
    const what = words === 'alles' ? 'Alles verkaufen' : `${words.charAt(0).toUpperCase()}${words.slice(1)} verkaufen`;
    if (!now || size.shares === null) return <>{what}{span}</>;
    return (
      <>
        {what}: {words === 'alles' ? `${qty(now.quantity)} Stück` : `${qty(size.shares)} von ${qty(now.quantity)} Stück`}
        {size.euros !== null && <>, ≈ {roundEur(size.euros)}</>}{span}
      </>
    );
  }
  return (
    <>
      {before > 0 ? 'Nachkaufen' : 'Kaufen'}{size.shares !== null ? `: ${qty(size.shares)} Stück` : ''} für ≈ {roundEur(size.euros)}{span}
    </>
  );
}

/**
 * What a stop of this kind did in the backtest, on hover: how often it fired,
 * what it cost against holding, what it spared at the bad end. A stop is an
 * insurance with a premium, and this is the premium.
 */
function EvidenceNote({ evidence, rule }: { evidence: StopEvidence | null; rule: 'stop' | 'trailing' }) {
  if (!evidence) return null;
  const at = (h: number) => evidence.rows.find((r) => r.rule === rule && r.group === 'all' && r.horizon === h);
  const q = at(3), h = at(6);
  if (!q || !h) return null;
  const pp = (x: number | null | undefined) => (x == null ? '—' : `${deNumber(Math.abs(x) * 100, 1)} Prozentpunkte`);
  const text = `Im Backtest (S&P 1500, ${evidence.from.slice(0, 4)}–${evidence.to.slice(0, 4)}) löste ein solcher Stop bei ${pct(q.stopped)} der Positionen `
    + `binnen drei Monaten aus, bei ${pct(h.stopped)} binnen sechs. Gegenüber Halten ${(h.diff.mean ?? 0) < 0 ? 'kostete' : 'brachte'} er über sechs Monate `
    + `im Schnitt ${pp(h.diff.mean)}${h.diffIndex?.mean != null ? `, mit dem Geld danach im Index ${pp(h.diffIndex.mean)}` : ''}. `
    + `Dafür das schlechteste Zwanzigstel: ohne Stop ${fmtSignedPct(h.p05Hold ?? 0)}, mit ${fmtSignedPct(h.p05Rule ?? 0)}; `
    + `Verluste ab 20 % bei ${pct(h.deepRule)} statt ${pct(h.deepHold)} der Positionen.`;
  return (
    <Tip content={text}>
      <span className="ml-2 cursor-help text-2xs text-ink-500 underline decoration-dotted">Backtest</span>
    </Tip>
  );
}

/**
 * The protection as an order to place, with where its level comes from; each
 * price in the stock's currency, as a chart shows it, and in euros beside it,
 * as Trade Republic takes the order.
 */
function ProtectionWords({ p, choice, own, rate }: { p: Protection; choice: ProtectionChoice; own: number | null; rate: number | null }) {
  if (choice === 'keiner') return <span className="text-ink-400">kein Stop</span>;
  const px = (v: number) => `${fmtPrice(v, p.currency)}${rate && p.currency !== 'EUR' ? ` (≈ ${fmtPrice(v * rate, 'EUR')})` : ''}`;
  // A level from the owner's note the manager took: below the close, and not absurdly far.
  if (choice === 'stop' && own !== null && own < p.close && own > p.close * 0.5) {
    return (
      <span className="text-ink-100">
        Stop-Loss bei {px(own)} setzen
        <span className="text-ink-500">
          {' '}· {pct(1 - own / p.close)} unter dem Kurs von {px(p.close)} am {fmtDay(p.asOf)}, deine Marke
          {p.stop && ` (berechnet: ${px(p.stop.price)})`}
        </span>
      </span>
    );
  }
  if (choice === 'stop' && p.stop) {
    return (
      <span className="text-ink-100">
        Stop-Loss bei {px(p.stop.price)} setzen
        <span className="text-ink-500">
          {' '}· {pct(-p.stop.distance)} unter dem Kurs von {px(p.close)} am {fmtDay(p.asOf)}
          {p.stop.basis === 'support' && p.stop.level !== null
            ? `, knapp unter der Unterstützung bei ${px(p.stop.level)}`
            : ', drei Tagesschwankungen tiefer — keine Unterstützung in Reichweite'}
        </span>
      </span>
    );
  }
  if (choice === 'trailing' && p.trailing) {
    return (
      <span className="text-ink-100">
        Trailing-Stop mit {pct(p.trailing.width)} Abstand setzen
        <span className="text-ink-500">
          {' '}· beginnt bei ≈ {px(p.close * (1 - p.trailing.width))} und zieht mit jedem neuen Hoch nach;
          {' '}der Abstand sind drei übliche Tagesschwankungen
        </span>
      </span>
    );
  }
  return <span className="text-ink-500">keine Marke berechnet</span>;
}

/**
 * The owner's note on a stock, for the depot manager: what he sees in it — a
 * level, a plan, a doubt. Kept apart from the journal, and sent to the model
 * as written (CLAUDE.md); the manager answers it the next time it is asked.
 */
function Note({ symbol, note, changed, onNotes }: {
  symbol: string; note: DepotNote | null; changed: boolean; onNotes: (notes: Record<string, DepotNote>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      setError(null);
      onNotes((await api.setDepotNote(symbol, text)).notes);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (editing) {
    return (
      <div className="mt-1.5 grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs">
        <span className="pt-1 text-ink-500">deine Notiz</span>
        <div>
          <textarea
            autoFocus
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="z. B. Ich sehe einen starken Support bei 13 $, Stop-Loss eher bei 12,70 $."
            className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-ink-100 placeholder:text-ink-600 focus:border-accent focus:outline-none"
          />
          <div className="mt-1 flex items-center gap-2">
            <button onClick={() => void save()} className="rounded bg-accent px-2 py-0.5 text-ink-950 hover:bg-accent-dark">Speichern</button>
            <button onClick={() => { setEditing(false); setText(note?.text ?? ''); }} className="text-ink-400 hover:text-ink-100">Abbrechen</button>
            <span className="text-2xs text-ink-500">Geht so an den Depotmanager, wenn du ihn neu fragst.</span>
            {error && <span className="text-red-400">{error}</span>}
          </div>
        </div>
      </div>
    );
  }
  if (!note) {
    return (
      <button onClick={() => setEditing(true)} className="mt-1 text-2xs text-ink-500 hover:text-ink-200">
        + Notiz für den Depotmanager
      </button>
    );
  }
  return (
    <div className="mt-1.5 grid grid-cols-[7.5rem_1fr] gap-x-3 text-xs leading-relaxed">
      <span className="text-ink-500">deine Notiz</span>
      <span className="text-ink-300">
        {note.text}
        <button onClick={() => { setText(note.text); setEditing(true); }} className="ml-2 text-2xs text-ink-500 hover:text-ink-200">ändern</button>
        {changed && <span className="ml-2 text-2xs text-accent">noch nicht beantwortet</span>}
      </span>
    </div>
  );
}

/**
 * Money ready to invest, entered here: the depot check sizes its purchases
 * by it. The model is told it as a share of the depot, never the amount.
 */
function Cash({ initial, totalEur }: { initial: number | null; totalEur: number }) {
  const [value, setValue] = useState(initial === null ? '' : String(initial));
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(initial === null ? '' : String(initial)); setSaved(initial); }, [initial]);
  async function save() {
    const parsed = value.trim() === '' ? null : Number(value.replace(/\./g, '').replace(',', '.'));
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) { setError('Kein Betrag'); return; }
    if (parsed === saved) return;
    try {
      setError(null);
      setSaved((await api.setDepotCash(parsed)).amountEur);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-400">
      <Tip content="Geld, das du bereitliegen hast. Der Depotmanager plant Käufe damit; er bekommt nur den Anteil am Depotwert, nie den Betrag.">
        <span>Verfügbar zum Investieren</span>
      </Tip>
      <input
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder="—"
        className="w-28 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-right font-mono text-ink-100 focus:border-accent focus:outline-none"
      />
      <span>€</span>
      {saved !== null && totalEur > 0 && <span className="text-ink-500">≈ {pct(saved / totalEur)} des Depots</span>}
      {error && <span className="text-red-400">{error}</span>}
    </label>
  );
}

function chartTip(h: CheckedStock, label: string): string {
  const p = h.protection;
  const facts = p ? [
    p.rsi !== null ? `RSI ${Math.round(p.rsi)}` : null,
    p.overSma200 !== null ? `${fmtSignedPct(p.overSma200)} zur 200-Tage-Linie` : null,
    p.channel ? `im 3-Monats-Kanal: ${p.channel}` : null,
  ].filter(Boolean).join(' · ') : '';
  return `${label}${h.chart?.phase ? ` — ${h.chart.phase}` : ''} (gelesen bis ${h.chart ? fmtDay(h.chart.asOf) : '—'}): ${h.chart?.summary ?? ''}${facts ? `\n${facts}` : ''}`;
}

function List({ title, tone, rows, hint, empty, moves, onOpen, totalEur }: {
  title: string; tone: string; rows: CheckedStock[]; hint: string; empty?: string;
  moves: Map<string, ManagerMove>; onOpen: (symbol: string) => void; totalEur: number;
}) {
  if (rows.length === 0 && !empty) return null;
  return (
    // A grid cell shrinks below its content only when told to, and the names truncate only once it does.
    <div className="min-w-0">
      <h4 className={`mb-1 text-xs font-semibold ${tone}`}>
        <Tip content={hint}><span>{title}</span></Tip>
        {rows.length > 0 && <span className="ml-1 font-normal text-ink-500">({rows.length})</span>}
      </h4>
      {rows.length === 0 ? <p className="text-xs text-ink-500">{empty}</p> : (
        <ul className="-mx-2">
          {rows.map((c) => {
            const t = c.chart ? TREND[c.chart.trend] : null;
            const m = moves.get(c.symbol);
            return (
              <li key={c.symbol}>
                <button
                  onClick={() => onOpen(c.symbol)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition hover:bg-ink-800"
                >
                  <StockLogo symbol={c.symbol} domain={null} fallbackInitials={initialsFromName(c.name ?? c.symbol)} size={18} />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-100">
                    {c.name ?? c.symbol} <span className="font-mono text-2xs text-ink-500">{c.symbol}</span>
                  </span>
                  {t && (
                    <Tip focusable={false} content={chartTip(c, t.label)}>
                      <span className={`font-mono text-sm ${t.cls}`}>{t.mark}</span>
                    </Tip>
                  )}
                  {c.verdict && <RecommendationBadge rec={c.verdict} size="sm" />}
                  <Tip focusable={false} content={c.scoreBefore !== null && c.score !== null && c.scoreBefore !== c.score
                    ? `Vor der Analyse ${score(c.scoreBefore)}, danach ${score(c.score)}` : 'Score'}
                  >
                    <span className={`w-8 text-right font-mono text-sm font-semibold tabular ${c.score === null ? 'text-ink-500' : scoreColor(c.score)}`}>
                      {c.score === null ? '—' : score(c.score)}
                    </span>
                  </Tip>
                </button>
                {m && (
                  <p className="px-2 pb-1 text-xs leading-relaxed text-ink-400">
                    <span className={`font-semibold uppercase tracking-wide ${ACTION[m.action]}`}>{m.action}</span>
                    {m.targetPct != null && <span className="text-ink-200"> · {stepWords(m, null, null, totalEur)}</span>}
                    {' '}— {m.reason}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The market the check read: Perplexity's brief in words, and the sectors as
 * measured — the US sector funds against the S&P 500 — beside what the brief
 * says of each and how much of the depot's stocks sit in it.
 */
function Market({ brief, error, trends, sectors }: {
  brief: MarketBrief | null; error: string | null; trends: SectorTrend[]; sectors: { sector: string; weight: number }[];
}) {
  const said = new Map((brief?.sectors ?? []).map((s) => [s.sector, s]));
  const held = new Map(sectors.map((s) => [s.sector, s.weight]));
  const signed = (x: number | null) => (x === null ? '—' : fmtSignedPct(x));
  const signedCls = (x: number | null) => (x === null ? 'text-ink-600' : x >= 0 ? 'text-emerald-400' : 'text-red-400');
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold text-ink-300">
        Marktlage
        {brief && <span className="ml-1 font-normal text-ink-500">· Perplexity {brief.model}, {fmtTime(brief.fetchedAt)}</span>}
      </h4>
      {brief ? (
        <div className="space-y-1.5 text-sm leading-relaxed text-ink-200">
          <p>{brief.state}</p>
          {brief.rotation && <p className="text-ink-300"><span className="text-ink-500">Rotation: </span>{brief.rotation}</p>}
        </div>
      ) : error && <p className="text-xs text-ink-500">Keine Marktlage: {error}</p>}

      {trends.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="text-2xs uppercase tracking-wider text-ink-500">
              <tr>
                <th className="py-1 pr-2 text-left font-semibold">Sektor</th>
                <th className="px-2 py-1 text-right font-semibold"><Tip content="Anteil an den Aktien im Depot"><span>Depot</span></Tip></th>
                <th className="px-2 py-1 text-right font-semibold"><Tip content="US-Sektorfonds gegen den S&P 500, ein Monat"><span>1 M</span></Tip></th>
                <th className="px-2 py-1 text-right font-semibold">3 M</th>
                <th className="px-2 py-1 text-right font-semibold">6 M</th>
                <th className="px-2 py-1 text-left font-semibold">
                  <Tip content="Gemessen: über drei Monate vor dem Index und im letzten Monat weiter vorne — führt; vorne, aber zuletzt zurück — verliert Schwung; hinten und weiter zurück — hinkt; hinten, aber zuletzt vorne — holt auf. Beschreibt die letzten Monate, keine geprüfte Vorhersage.">
                    <span>gemessen</span>
                  </Tip>
                </th>
                {brief && <th className="py-1 pl-2 text-left font-semibold">laut Recherche</th>}
              </tr>
            </thead>
            <tbody>
              {trends.map((t) => {
                const s = said.get(t.sector);
                const w = held.get(t.sector);
                return (
                  <tr key={t.sector} className="border-t border-ink-800/60">
                    <td className={`py-1 pr-2 ${w ? 'text-ink-100' : 'text-ink-400'}`}>
                      {t.sector} <span className="font-mono text-2xs text-ink-600">{t.etf}</span>
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular text-ink-300">{w ? pct(w) : ''}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular ${signedCls(t.rel1m)}`}>{signed(t.rel1m)}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular ${signedCls(t.rel3m)}`}>{signed(t.rel3m)}</td>
                    <td className={`px-2 py-1 text-right font-mono tabular ${signedCls(t.rel6m)}`}>{signed(t.rel6m)}</td>
                    <td className={`px-2 py-1 ${t.phase ? PHASE[t.phase] : 'text-ink-600'}`}>{t.phase ?? '—'}</td>
                    {brief && (
                      <td className="py-1 pl-2">
                        {s && (
                          <Tip content={s.why}>
                            <span className={DIRECTION[s.direction]}>{SECTOR_DIRECTION_LABEL[s.direction]}</span>
                          </Tip>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {brief && (brief.drivers.length > 0 || brief.problems.length > 0 || brief.calendar.length > 0) && (
        <details className="text-xs text-ink-300">
          <summary className="cursor-pointer text-ink-400 hover:text-ink-200">Treiber, Probleme, Termine und Quellen</summary>
          <div className="mt-2 grid gap-4 md:grid-cols-3">
            <Points title="Was den Markt bewegt" items={brief.drivers.map((d) => ({ text: d.impact ? <>{d.what} <span className="text-ink-500">— {d.impact}</span></> : d.what, source: d.source }))} />
            <Points title="Wo es Probleme gibt" items={brief.problems.map((x) => ({ text: x.what, source: x.source }))} />
            <Points title="Termine" items={brief.calendar.map((c) => ({ text: <>{c.date ? <span className="font-mono text-ink-400">{fmtDay(c.date)} </span> : null}{c.event}{c.watch && <span className="text-ink-500"> — {c.watch}</span>}</> }))} />
          </div>
          {brief.citations.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-2 text-2xs text-ink-500">
              Quellen:
              {brief.citations.map((u, i) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="hover:text-ink-300">[{i + 1}] {hostOf(u)}</a>
              ))}
            </p>
          )}
        </details>
      )}
    </div>
  );
}

function Points({ title, items }: { title: string; items: { text: ReactNode; source?: string | null }[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h5 className="mb-1 font-semibold text-ink-400">{title}</h5>
      <ul className="list-disc space-y-1 pl-4 leading-relaxed">
        {items.map((x, i) => (
          <li key={i}>
            {x.text}
            {x.source && <> <a href={x.source} target="_blank" rel="noreferrer" className="text-2xs text-ink-500 hover:text-ink-300">{hostOf(x.source)}</a></>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

const GROUP_LABEL = (g: RecordGroup) => (g.startsWith('liste: ') ? `Liste: ${g.slice(7)}` : g);
const GROUP_CLS = (g: RecordGroup) => (g.startsWith('liste: ') ? 'text-ink-300' : ACTION[g as ManagerAction]);

/**
 * What came of the checks kept: per kind of step, how the stocks did against
 * the S&P 500 since the check's day, and how often they went the way the
 * step bet. Every step below, by check. Little to go on for months, said as
 * such.
 */
function History({ h, onOpen }: { h: DepotCheckHistory; onOpen: (symbol: string) => void }) {
  const byCheck = h.checks.map((c) => ({ c, steps: h.outcomes.filter((o) => o.checkAt === c.generatedAt) }));
  const steps = h.outcomes.filter((o) => o.excess !== null).length;
  const thin = steps < 30 || (h.record[0]?.medianDays ?? 0) < 60;
  return (
    <div className="mt-5 space-y-2 border-t border-ink-800 pt-3">
      <h4 className="text-xs font-semibold text-ink-300">
        <Tip content="Jeder Schritt eines gespeicherten Checks, gemessen vom Tag des Checks bis heute gegen den S&P 500 (in Dollar, Dividenden eingerechnet), wie der Rückblick Käufe misst. Ein Kauf traf, wenn die Aktie den Index schlug; Reduzieren, Verkaufen und Gewinne mitnehmen, wenn sie zurückblieb; Halten und Beobachten werden nur gemessen. Dazu die beiden Listen des Checks für sich.">
          <span>Was aus den Checks wurde</span>
        </Tip>
        <span className="ml-1 font-normal text-ink-500">· {h.checks.length} {h.checks.length === 1 ? 'Check' : 'Checks'} seit {fmtTime(h.checks.at(-1)!.generatedAt)}</span>
      </h4>
      {h.record.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[30rem] text-xs">
            <thead className="text-2xs uppercase tracking-wider text-ink-500">
              <tr>
                <th className="py-1 pr-2 text-left font-semibold">Schritt</th>
                <th className="px-2 py-1 text-right font-semibold">Anzahl</th>
                <th className="px-2 py-1 text-right font-semibold"><Tip content="Median der Mehrrendite gegen den S&P 500 seit dem Check"><span>gegen S&P</span></Tip></th>
                <th className="px-2 py-1 text-right font-semibold"><Tip content="Wie oft die Aktie in die Richtung lief, auf die der Schritt setzte"><span>getroffen</span></Tip></th>
                <th className="py-1 pl-2 text-right font-semibold"><Tip content="Median der Tage seit dem Check"><span>Tage</span></Tip></th>
              </tr>
            </thead>
            <tbody>
              {h.record.map((g) => (
                <tr key={g.group} className="border-t border-ink-800/60">
                  <td className={`py-1 pr-2 ${GROUP_CLS(g.group)}`}>{GROUP_LABEL(g.group)}</td>
                  <td className="px-2 py-1 text-right font-mono tabular text-ink-300">{g.n}</td>
                  <td className={`px-2 py-1 text-right font-mono tabular ${g.medianExcess === null ? 'text-ink-600' : g.medianExcess >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {g.medianExcess === null ? '—' : fmtSignedPct(g.medianExcess)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular text-ink-300">
                    {GROUP_SIDE[g.group] === null || g.scored === 0 ? '—' : `${g.hits}/${g.scored}`}
                  </td>
                  <td className="py-1 pl-2 text-right font-mono tabular text-ink-500">{g.medianDays === null ? '—' : Math.round(g.medianDays)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {thin && (
        <p className="text-2xs text-ink-500">
          Noch wenig, worauf das ruht: {steps} gemessene Schritte. Wochen sind Rauschen; erst über Monate und viele Schritte
          sagt das etwas.
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-ink-400 hover:text-ink-200">Jeder Schritt</summary>
        <div className="mt-2 space-y-3">
          {byCheck.map(({ c, steps: xs }) => (
            <div key={c.id}>
              <div className="mb-0.5 text-2xs text-ink-500">{fmtTime(c.generatedAt)} · {c.model}</div>
              <ul className="space-y-0.5">
                {xs.map((o) => (
                  <li key={o.key} className="flex items-center gap-2">
                    <span className={`w-36 shrink-0 truncate ${GROUP_CLS(o.group)}`}>{GROUP_LABEL(o.group)}</span>
                    <button onClick={() => onOpen(o.symbol)} className="min-w-0 flex-1 truncate text-left text-ink-200 hover:text-ink-50">
                      {o.name ?? o.symbol} <span className="font-mono text-2xs text-ink-500">{o.symbol}</span>
                    </button>
                    <span className="w-14 text-right font-mono tabular text-ink-400">{o.stock === null ? '—' : fmtSignedPct(o.stock)}</span>
                    <span className={`w-14 text-right font-mono tabular ${o.excess === null ? 'text-ink-600' : o.excess >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {o.excess === null ? '—' : fmtSignedPct(o.excess)}
                    </span>
                    <span className="w-3 text-center">{o.hit === null ? '' : o.hit ? '✓' : '✗'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-2xs text-ink-500">Aktie seit dem Check · gegen den S&amp;P 500 · in die Richtung des Schritts</p>
        </div>
      </details>
    </div>
  );
}
