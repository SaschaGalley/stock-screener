import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useMoney } from '../../currency';
import type { OverviewRow, TechnicalSignals, TimingReadings } from '../../types';
import {
  CHART_PATTERN_STATUS_LABEL, channelMove,
  type ChartAnalysis, type ChartFinding, type ChartReadDoc, type ChartResponse, type PriceLevel,
} from '../../../../src/analysis/chart';
import { MODELS } from '../../../../src/models';
import PriceChart, { CHART_LAYERS, type ChartLayer } from '../charts/PriceChart';
import TechnicalSignalsPanel from './TechnicalSignalsPanel';
import { TimingEvidence, channelDirection, channelPlace } from '../TimingCell';
import { SetupPlan, firingSetups } from '../SetupBadge';
import { useVerdictEvidence } from '../VerdictEvidence';
import Term from '../Term';
import More from '../More';
import { useSectionFinding } from '../Section';
import type { GlossaryKey } from '../../glossary';

interface Props {
  symbol:   string;
  /** The stock's row in the list, for the timing readings and the setups; null when it has none. */
  row:      OverviewRow | null;
  /** From the stored market signals, for a stock the list has no row for. */
  timing:   TimingReadings | null;
  signals:  TechnicalSignals | null;
  /** The model picked for analyses, offered first for the chart reading. */
  model:    string;
  /** CSS height of the price chart. */
  chartHeight?: number | string;
}

const RANGES = [{ sessions: 126, label: '6 M' }, { sessions: 252, label: '1 J' }, { sessions: 504, label: '2 J' }] as const;
const CHANNELS = [{ sessions: 63, label: '3 M' }, { sessions: 126, label: '6 M' }, { sessions: 252, label: '1 J' }] as const;
const DEFAULT_LAYERS: ChartLayer[] = ['ma', 'channel', 'levels', 'trendlines', 'read'];
const LAYERS_KEY = 'stockcli:chart-layers';

const de = (x: number, d = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const pct = (x: number | null, d = 1) => (x === null ? '—' : `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`);
const dayDe = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.${d.slice(2, 4)}`;

const TONE_MARK: Record<ChartFinding['tone'], { mark: string; cls: string }> = {
  bull:    { mark: '▲', cls: 'text-emerald-400' },
  bear:    { mark: '▼', cls: 'text-red-400' },
  neutral: { mark: '•', cls: 'text-ink-500' },
};
const SOURCE_LABEL: Record<PriceLevel['source'], string> = {
  swing: 'Wendepunkte', high52: 'Jahreshoch', low52: 'Jahrestief', poc: 'Volumen-POC',
};

function readLayers(): Set<ChartLayer> {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    if (raw) return new Set(JSON.parse(raw) as ChartLayer[]);
  } catch { /* fall through */ }
  return new Set(DEFAULT_LAYERS);
}

/**
 * The chart and what it says: candles with the levels, channels and lines
 * drawn in, the findings as sentences, the levels and channels as tables,
 * the timing readings and setups the list shows in one word — here with the
 * backtest beside them — and, on request, a model's reading of the chart.
 * The old indicator vote stays at the bottom, folded away.
 */
export default function ChartTechnicals({ symbol, row, timing, signals, model, chartHeight }: Props) {
  const money = useMoney();
  const evidence = useVerdictEvidence();
  const [data, setData] = useState<ChartResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<number>(252);
  const [channel, setChannel] = useState<number>(63);
  const [layers, setLayers] = useState<Set<ChartLayer>>(readLayers);
  const [read, setRead] = useState<ChartReadDoc | null>(null);

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    api.getChart(symbol)
      .then((r) => { if (live) { setData(r); setRead(r.read); } })
      .catch((e) => { if (live) { setError((e as Error).message); setData(null); } });
    return () => { live = false; };
  }, [symbol]);

  const toggle = (l: ChartLayer) => setLayers((prev) => {
    const next = new Set(prev);
    if (next.has(l)) next.delete(l); else next.add(l);
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });

  const a = data?.analysis ?? null;
  const t = row?.timing ?? timing;
  useSectionFinding(a ? chartFinding(a) : null);

  if (data === undefined) return <p className="py-8 text-center text-sm text-ink-500">Lade Kursdaten …</p>;
  if (error) return <p className="text-sm text-red-400">⚠ {error}</p>;

  return (
    <div className="space-y-4">
      {a && <Summary a={a} t={t} row={row} />}

      {data && data.bars.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
            <Segmented options={RANGES.map((r) => ({ value: r.sessions, label: r.label }))} value={sessions} onChange={setSessions} />
            <span className="text-ink-600">|</span>
            <span className="text-ink-500">Kanal</span>
            <Segmented options={CHANNELS.map((c) => ({ value: c.sessions, label: c.label }))} value={channel} onChange={setChannel} />
            <div className="flex flex-wrap gap-1">
              {CHART_LAYERS.filter((l) => l.key !== 'read' || read).map((l) => (
                <button
                  key={l.key}
                  onClick={() => toggle(l.key)}
                  className={`rounded-full border px-2 py-0.5 transition ${
                    layers.has(l.key) ? 'border-ink-600 bg-ink-800 text-ink-200' : 'border-ink-800 text-ink-500 hover:text-ink-300'
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded border border-ink-700 bg-ink-950 p-2">
            <PriceChart
              data={data}
              sessions={sessions}
              channel={channel}
              layers={layers}
              read={read?.read ?? null}
              fmtPrice={money.fmtPrice}
              height={chartHeight}
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-500">Keine Kursdaten im Archiv.</p>
      )}

      {a && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Findings findings={a.findings} />
          <Levels a={a} fmtPrice={money.fmtPrice} />
        </div>
      )}

      {data && data.bars.length > 0 && (
        <ChartReadPanel symbol={symbol} model={model} read={read} asOf={a?.asOf ?? null} onRead={setRead} />
      )}

      {(a || t || signals) && (
        <More label="Trendkanäle, Durchschnitte, Volumen, Timing-Lesung, Setups und Indikator-Abstimmung">
          {a && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Channels a={a} fmtPrice={money.fmtPrice} />
              <Structure a={a} fmtPrice={money.fmtPrice} />
            </div>
          )}
          {t && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Block title="Timing-Lesung mit Backtest">
                <div className="text-xs"><TimingEvidence t={t} verdict={row?.recommendation ?? null} evidence={evidence} /></div>
              </Block>
              <Setups row={row} evidence={evidence} />
            </div>
          )}
          {signals && (
            <Block title="Indikator-Abstimmung" term="tech.vote">
              <TechnicalSignalsPanel signals={signals} />
            </Block>
          )}
        </More>
      )}

      <p className="text-2xs leading-relaxed text-ink-500">
        Marken, Kanäle, Linien und Muster beschreiben den Chart; geprüft hat der Backtest davon nur die Timing-Lesungen. Nichts in
        diesem Bereich fließt in Score oder Urteil ein. Gerechnet aus den archivierten, splitbereinigten Tageskursen
        {a ? `, Stand ${dayDe(a.asOf)}` : ''}.
      </p>
    </div>
  );
}

function Segmented<T extends number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-ink-700">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 transition ${o.value === value ? 'bg-ink-700 text-ink-50' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The section header's line: trend, place in the channel, the nearest levels. */
function chartFinding(a: ChartAnalysis): string {
  const trend = { up: 'Aufwärtstrend', down: 'Abwärtstrend', sideways: 'Seitwärts' }[a.structure.trend];
  const q = a.channels.find((c) => c.sessions === 63);
  const where = !q ? null : q.z <= -1 ? 'unten im 3-M-Kanal' : q.z >= 1 ? 'oben im 3-M-Kanal' : 'Mitte des 3-M-Kanals';
  const sup = a.levels.filter((l) => l.kind === 'support')[0];
  const res = a.levels.filter((l) => l.kind === 'resistance').at(-1);
  return [
    trend, where,
    res && `Widerstand ${de(res.price)} (${pct(res.distance)})`,
    sup && `Unterstützung ${de(sup.price)} (${pct(sup.distance)})`,
  ].filter(Boolean).join(' · ');
}

// ── Summary ──────────────────────────────────────────────────────────────────

function Chip({ label, value, tone }: { label: string; value: string; tone?: 'bull' | 'bear' | 'neutral' }) {
  const cls = tone === 'bull' ? 'text-emerald-400' : tone === 'bear' ? 'text-red-400' : 'text-ink-100';
  return (
    <div className="rounded border border-ink-800 bg-ink-950 px-2.5 py-1.5">
      <div className="text-2xs uppercase tracking-wider text-ink-500">{label}</div>
      <div className={`whitespace-nowrap text-sm ${cls}`}>{value}</div>
    </div>
  );
}

/** The one-line reading at the top: trend, channel, nearest levels, averages, RSI, setups. */
function Summary({ a, t, row }: { a: ChartAnalysis; t: TimingReadings | null; row: OverviewRow | null }) {
  const sup = a.levels.filter((l) => l.kind === 'support')[0];
  const res = a.levels.filter((l) => l.kind === 'resistance').at(-1);
  const trendWord = { up: 'Aufwärts', down: 'Abwärts', sideways: 'Seitwärts' }[a.structure.trend];
  const d = t ? channelDirection(t) : null;
  const setups = row ? firingSetups(row) : [];
  const vs200 = a.ma.sma200 !== null ? a.close / a.ma.sma200 - 1 : null;
  return (
    <div className="flex flex-wrap gap-2">
      <Chip label="Trend" value={`${trendWord}${a.structure.highs && a.structure.lows ? ` · ${a.structure.highs === 'higher' ? 'HH' : a.structure.highs === 'lower' ? 'LH' : 'EH'}/${a.structure.lows === 'higher' ? 'HL' : a.structure.lows === 'lower' ? 'LL' : 'EL'}` : ''}`}
        tone={a.structure.trend === 'up' ? 'bull' : a.structure.trend === 'down' ? 'bear' : 'neutral'} />
      {t && d && <Chip label="3-M-Kanal" value={`${d.arrow} ${channelPlace(t)}${t.channelZ !== null ? ` ${de(t.channelZ, 1)}σ` : ''}`} />}
      {sup && <Chip label="Unterstützung" value={`${de(sup.price)} (${pct(sup.distance)})`} />}
      {res && <Chip label="Widerstand" value={`${de(res.price)} (${pct(res.distance)})`} />}
      {vs200 !== null && <Chip label="vs. SMA 200" value={pct(vs200)} tone={vs200 >= 0 ? 'bull' : 'bear'} />}
      {a.rsi14 !== null && <Chip label="RSI 14" value={de(a.rsi14, 0)} tone={a.rsi14 >= 70 ? 'bear' : a.rsi14 <= 30 ? 'bull' : 'neutral'} />}
      {a.atr !== null && <Chip label="ATR 14" value={pct(a.atr / a.close).replace('+', '')} />}
      {setups.length > 0 && <Chip label="Setup" value={setups.length === 1 ? setups[0].title : `${setups.length} Setups`} />}
    </div>
  );
}

// ── Blocks ───────────────────────────────────────────────────────────────────

function Block({ title, term, children }: { title: string; term?: GlossaryKey; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">
        {term ? <Term k={term}>{title}</Term> : title}
      </h3>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Findings({ findings }: { findings: ChartFinding[] }) {
  return (
    <Block title="Was der Chart zeigt">
      <ul className="space-y-1 text-xs leading-relaxed text-ink-200">
        {findings.map((f) => (
          <li key={f.key} className="flex gap-2">
            <span className={`w-3 shrink-0 text-center ${TONE_MARK[f.tone].cls}`}>{TONE_MARK[f.tone].mark}</span>
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
    </Block>
  );
}

function Levels({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  const above = a.levels.filter((l) => l.kind === 'resistance');
  const below = a.levels.filter((l) => l.kind === 'support');
  const rowFor = (l: PriceLevel) => (
    <tr key={`${l.kind}-${l.price}`} className="border-b border-ink-800">
      <td className={`py-1 pr-2 ${l.kind === 'support' ? 'text-emerald-400' : 'text-red-400'}`}>{l.kind === 'support' ? 'Unterstützung' : 'Widerstand'}</td>
      <td className="py-1 px-2 text-right font-mono text-ink-100">{fmtPrice(l.price)}</td>
      <td className="py-1 px-2 text-right font-mono text-ink-300">{pct(l.distance)}</td>
      <td className="py-1 px-2 text-right font-mono text-ink-400">{l.distanceAtr !== null ? de(Math.abs(l.distanceAtr), 1) : '—'}</td>
      <td className="py-1 pl-2 text-ink-400">
        {SOURCE_LABEL[l.source]}{l.touches > 1 ? ` · ${l.touches}×` : ''}{l.flipped ? ' · Rollentausch' : ''}
        <span className="ml-1 inline-block h-1 w-8 overflow-hidden rounded bg-ink-800 align-middle">
          <span className="block h-full bg-ink-400" style={{ width: `${Math.round(l.strength * 100)}%` }} />
        </span>
      </td>
    </tr>
  );
  return (
    <Block title="Unterstützungen und Widerstände" term="tech.levels">
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium" />
            <th className="py-1 px-2 text-right font-medium">Preis</th>
            <th className="py-1 px-2 text-right font-medium">Abstand</th>
            <th className="py-1 px-2 text-right font-medium">ATR</th>
            <th className="py-1 pl-2 text-left font-medium">Herkunft · Stärke</th>
          </tr>
        </thead>
        <tbody>
          {above.map(rowFor)}
          <tr className="border-b border-ink-800 bg-ink-900">
            <td className="py-1 pr-2 font-semibold text-ink-200">Kurs</td>
            <td className="py-1 px-2 text-right font-mono font-semibold text-ink-50">{fmtPrice(a.close)}</td>
            <td colSpan={3} className="py-1 pl-2 text-ink-500">{dayDe(a.asOf)}</td>
          </tr>
          {below.map(rowFor)}
        </tbody>
      </table>
    </Block>
  );
}

function Channels({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  return (
    <Block title="Trendkanäle" term="tech.channels">
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium">Zeitraum</th>
            <th className="py-1 px-2 text-right font-medium">Steigung</th>
            <th className="py-1 px-2 text-right font-medium">R²</th>
            <th className="py-1 px-2 text-right font-medium">Lage</th>
            <th className="py-1 pl-2 text-right font-medium">Kanal heute</th>
          </tr>
        </thead>
        <tbody>
          {a.channels.map((c) => {
            const move = channelMove(c);
            return (
              <tr key={c.sessions} className="border-b border-ink-800">
                <td className="py-1 pr-2 text-ink-300">{c.label}</td>
                <td className={`py-1 px-2 text-right font-mono ${c.slope > 0.15 ? 'text-emerald-400' : c.slope < -0.15 ? 'text-red-400' : 'text-ink-300'}`}>{pct(move, 0)}</td>
                <td className={`py-1 px-2 text-right font-mono ${c.r2 < 0.3 ? 'text-ink-500' : 'text-ink-200'}`}>{de(c.r2)}</td>
                <td className="py-1 px-2 text-right font-mono text-ink-200">{de(c.z, 1)}σ</td>
                <td className="whitespace-nowrap py-1 pl-2 text-right font-mono text-ink-400">{fmtPrice(c.lower[1])} – {fmtPrice(c.upper[1])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {a.trendlines.length > 0 && (
        <div className="mt-3">
          <h4 className="mb-1 text-2xs uppercase tracking-wider text-ink-500"><Term k="tech.trendlines">Trendlinien</Term></h4>
          <ul className="space-y-0.5 text-xs text-ink-300">
            {a.trendlines.map((t) => (
              <li key={t.kind}>
                <span className={t.kind === 'support' ? 'text-emerald-400' : 'text-red-400'}>{t.kind === 'support' ? 'Tiefs' : 'Hochs'}</span>{' '}
                {dayDe(t.from.day)} {fmtPrice(t.from.price)} → {dayDe(t.to.day)} {fmtPrice(t.to.price)}, heute{' '}
                <span className="font-mono text-ink-100">{fmtPrice(t.now)}</span>
                {t.broken && <span className="text-ink-500"> · gebrochen am {dayDe(t.brokenAt!)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Block>
  );
}

/** Averages, volume zone, Fibonacci, gaps, divergences, squeeze — the rest of the reading as numbers. */
function Structure({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  const rows: [React.ReactNode, React.ReactNode][] = [];
  const ma = (v: number | null) => (v === null ? '—' : `${fmtPrice(v)} (${pct(a.close / v - 1)})`);
  rows.push(['SMA 20', <span className="font-mono">{ma(a.ma.sma20)}</span>]);
  rows.push(['SMA 50', <span className="font-mono">{ma(a.ma.sma50)}</span>]);
  rows.push(['SMA 200', <span className="font-mono">{ma(a.ma.sma200)}</span>]);
  if (a.ma.cross) rows.push([`Letzter Schnitt 50/200`, `${a.ma.cross.kind === 'golden' ? 'Golden Cross' : 'Death Cross'} am ${dayDe(a.ma.cross.day)}`]);
  if (a.ma.sma200Slope !== null) rows.push(['200-Tage-Linie, letzter Monat', <span className="font-mono">{pct(a.ma.sma200Slope)}</span>]);
  if (a.profile) {
    rows.push([<Term k="tech.profile">Volumen-POC (1 J)</Term>,
      <span className="font-mono">{fmtPrice(a.profile.poc)} · Zone {fmtPrice(a.profile.valueLow)} – {fmtPrice(a.profile.valueHigh)}</span>]);
  }
  if (a.squeeze) {
    rows.push(['Bollinger-Bandbreite', `${de(a.squeeze.bandwidth * 100, 1)} % — enger als ${Math.round((1 - a.squeeze.percentile) * 100)} % des Jahres`]);
  }
  if (a.fibonacci) {
    const f = a.fibonacci;
    rows.push([`Fibonacci ${f.dir === 'up' ? '↗' : '↘'} ${dayDe(f.from.day)}–${dayDe(f.to.day)}`,
      <span className="font-mono">{f.levels.filter((l) => [0.382, 0.5, 0.618].includes(l.ratio)).map((l) => `${de(l.ratio * 100, 1)} % ${fmtPrice(l.price)}`).join(' · ')}</span>]);
  }
  for (const d of a.divergences) {
    rows.push([`${d.kind === 'bullish' ? 'Bullische' : 'Bärische'} Divergenz`,
      `${dayDe(d.from.day)} → ${dayDe(d.to.day)}: Kurs ${d.kind === 'bullish' ? 'tiefer' : 'höher'}, RSI ${de(d.from.rsi, 0)} → ${de(d.to.rsi, 0)}`]);
  }
  for (const g of a.gaps) {
    rows.push([`Offene Lücke ${g.dir === 'up' ? '↑' : '↓'} ${dayDe(g.day)}`, <span className="font-mono">{fmtPrice(g.low)} – {fmtPrice(g.high)}</span>]);
  }
  for (const b of a.breakouts) {
    rows.push([`${b.dir === 'up' ? 'Ausbruch' : 'Bruch'} ${dayDe(b.day)}`,
      `${b.dir === 'up' ? 'über' : 'unter'} ${fmtPrice(b.level)}${b.volumeRatio !== null ? `, Volumen ${de(b.volumeRatio, 1)}×` : ''}`]);
  }
  return (
    <Block title="Durchschnitte, Volumen, Muster">
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([label, value], k) => (
            <tr key={k} className="border-b border-ink-800">
              <td className="py-1 pr-2 align-top text-ink-400">{label}</td>
              <td className="py-1 pl-2 text-right text-ink-200">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Block>
  );
}

function Setups({ row, evidence }: { row: OverviewRow | null; evidence: ReturnType<typeof useVerdictEvidence> }) {
  const t = row?.timing ?? null;
  const setups = row ? firingSetups(row) : [];
  return (
    <Block title="Setups">
      {row && t && setups.length > 0 ? (
        <div className="text-xs"><SetupPlan row={row} t={t} setups={setups} study={evidence?.setups ?? null} /></div>
      ) : (
        <p className="text-xs text-ink-500">
          Heute schlägt keines der fünf vorab festgelegten Setups an (unterbewertet unten im Kanal, unterbewertet vom Tief abgeprallt,
          Rücksetzer im Aufwärtstrend, am Jahreshoch, vom Tief abgeprallt).
        </p>
      )}
    </Block>
  );
}

// ── The model's reading ──────────────────────────────────────────────────────

const CASE_STYLE = {
  bull: { label: 'Bull', cls: 'border-emerald-800 text-emerald-300' },
  bear: { label: 'Bear', cls: 'border-red-800 text-red-300' },
  base: { label: 'Basis', cls: 'border-ink-700 text-ink-300' },
} as const;
const STRENGTH_LABEL = { strong: 'stark', medium: 'mittel', weak: 'schwach' } as const;
const DIRECTION_LABEL = { up: 'aufwärts', down: 'abwärts', sideways: 'seitwärts' } as const;

function ChartReadPanel({ symbol, model, read, asOf, onRead }: {
  symbol: string; model: string; read: ChartReadDoc | null; asOf: string | null; onRead: (r: ChartReadDoc) => void;
}) {
  const money = useMoney();
  const [pick, setPick] = useState(() => (MODELS.some((m) => m.id === model) ? model : MODELS[0].id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { onRead(await api.runChartRead(symbol, pick)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const r = read?.read ?? null;
  const stale = r && asOf && r.asOf < asOf;
  const label = (id: string | null) => MODELS.find((m) => m.id === id)?.label ?? id ?? '—';

  return (
    <div className="rounded border border-ink-700 bg-ink-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-300"><Term k="tech.chartRead">KI-Chartlesung</Term></h3>
        {read && (
          <span className="text-2xs text-ink-500">
            {label(read.model)} · {new Date(read.producedAt).toLocaleDateString('de-DE')} · Kurse bis {dayDe(read.read.asOf)}
            {stale && <span className="text-amber-300/80"> · neuere Kurse liegen vor</span>}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            disabled={busy}
            className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-xs text-ink-200"
          >
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-xs text-ink-100 transition hover:bg-ink-700 disabled:opacity-50"
          >
            {busy ? 'liest den Chart …' : r ? '↻ Neu lesen' : 'Chart lesen lassen'}
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">⚠ {error}</p>}
      {!r && !busy && !error && (
        <p className="mt-2 text-xs text-ink-500">
          Ein Sprachmodell bekommt zwei Jahre Wochenkerzen, das letzte Quartal in Tageskerzen und die Marken von oben, und sucht Chartmuster,
          wichtige Marken und Szenarien mit Auslösern. Eine Anfrage, je nach Modell einige Sekunden bis zwei Minuten.
        </p>
      )}
      {busy && !r && <p className="mt-2 text-xs text-ink-500">Das Modell liest den Chart — je nach Modell bis zu zwei Minuten.</p>}

      {r && (
        <div className={`mt-3 space-y-3 ${busy ? 'opacity-50' : ''}`}>
          <p className="text-sm leading-relaxed text-ink-100">{r.summary}</p>
          <p className="text-xs text-ink-400">
            Trend <span className="text-ink-200">{DIRECTION_LABEL[r.trend.direction]}</span>
            {r.trend.phase && <> · Phase <span className="text-ink-200">{r.trend.phase}</span></>}
            {r.trend.comment && <> — {r.trend.comment}</>}
          </p>

          {r.patterns.length > 0 && (
            <div>
              <h4 className="mb-1 text-2xs uppercase tracking-wider text-ink-500">Muster</h4>
              <ul className="space-y-1.5 text-xs">
                {r.patterns.map((p, k) => (
                  <li key={k}>
                    <span className="font-semibold text-ink-100">{p.name}</span>{' '}
                    <span className={`rounded border px-1 text-2xs ${p.status === 'confirmed' ? 'border-emerald-800 text-emerald-300' : p.status === 'failed' ? 'border-red-800 text-red-300' : 'border-ink-700 text-ink-400'}`}>
                      {CHART_PATTERN_STATUS_LABEL[p.status]}
                    </span>
                    {p.from && <span className="text-ink-500"> {dayDe(p.from)}{p.to ? `–${dayDe(p.to)}` : ''}</span>}
                    {p.trigger !== null && <span className="text-ink-400"> · Auslöser <span className="font-mono text-ink-200">{money.fmtPrice(p.trigger)}</span></span>}
                    {p.target !== null && <span className="text-ink-400"> · Ziel <span className="font-mono text-ink-200">{money.fmtPrice(p.target)}</span></span>}
                    {p.comment && <div className="text-ink-400">{p.comment}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {r.scenarios.length > 0 && (
            <div className="grid gap-2 md:grid-cols-3">
              {r.scenarios.map((s, k) => (
                <div key={k} className={`rounded border px-2 py-1.5 text-xs ${CASE_STYLE[s.case].cls}`}>
                  <div className="font-semibold">
                    {CASE_STYLE[s.case].label}
                    {s.target !== null && <span className="font-mono font-normal"> → {money.fmtPrice(s.target)}</span>}
                  </div>
                  <div className="text-ink-300">{s.trigger}</div>
                  {s.comment && <div className="mt-0.5 text-ink-500">{s.comment}</div>}
                </div>
              ))}
            </div>
          )}

          {r.levels.length > 0 && (
            <div>
              <h4 className="mb-1 text-2xs uppercase tracking-wider text-ink-500">Marken laut Modell</h4>
              <table className="w-full text-xs">
                <tbody>
                  {[...r.levels].sort((x, y) => y.price - x.price).map((l, k) => (
                    <tr key={k} className="border-b border-ink-800">
                      <td className={`py-1 pr-2 ${l.kind === 'support' ? 'text-emerald-400' : 'text-red-400'}`}>{l.kind === 'support' ? 'U' : 'W'}</td>
                      <td className="py-1 pr-2 text-right font-mono text-ink-100">{money.fmtPrice(l.price)}</td>
                      <td className="py-1 pr-2 text-ink-500">{STRENGTH_LABEL[l.strength]}</td>
                      <td className="py-1 text-ink-300">{l.comment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(r.invalidation || r.watch.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2 text-xs">
              {r.invalidation && (
                <div>
                  <h4 className="mb-1 text-2xs uppercase tracking-wider text-ink-500">Widerlegt, wenn</h4>
                  <p className="text-ink-300">{r.invalidation}</p>
                </div>
              )}
              {r.watch.length > 0 && (
                <div>
                  <h4 className="mb-1 text-2xs uppercase tracking-wider text-ink-500">Beobachten</h4>
                  <ul className="list-disc space-y-0.5 pl-4 text-ink-300">{r.watch.map((w, k) => <li key={k}>{w}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          <p className="text-2xs text-ink-500">
            Lesart eines Sprachmodells aus Kursdaten allein. Chartmuster sind in dieser App nicht backtestet, und Modelle sehen Muster
            auch dort, wo keine sind. Keine Anlageberatung.
          </p>
        </div>
      )}
    </div>
  );
}
