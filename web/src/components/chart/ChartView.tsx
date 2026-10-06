import { useEffect, useRef, useState } from 'react';
import type { ChartRead, ChartResponse } from '../../../../src/analysis/chart';
import PriceChart, { CHART_LAYERS, type ChartLayer } from '../charts/PriceChart';

const RANGES = [{ sessions: 126, label: '6 M' }, { sessions: 252, label: '1 J' }, { sessions: 504, label: '2 J' }] as const;
const CHANNELS = [{ sessions: 63, label: '3 M' }, { sessions: 126, label: '6 M' }, { sessions: 252, label: '1 J' }] as const;
const DEFAULT_LAYERS: ChartLayer[] = ['ma', 'channel', 'levels', 'trendlines', 'read'];
const LAYERS_KEY = 'stockcli:chart-layers';

function readLayers(): Set<ChartLayer> {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    if (raw) return new Set(JSON.parse(raw) as ChartLayer[]);
  } catch { /* fall through */ }
  return new Set(DEFAULT_LAYERS);
}

/** The candles with what is drawn over them, and the controls for both. */
export default function ChartView({ data, read, fmtPrice, height }: {
  data: ChartResponse; read: ChartRead | null; fmtPrice: (n: number) => string; height?: number | string;
}) {
  const [sessions, setSessions] = useState<number>(252);
  const [channel, setChannel] = useState<number>(63);
  const [layers, setLayers] = useState<Set<ChartLayer>>(readLayers);
  const toggle = (l: ChartLayer) => setLayers((prev) => {
    const next = new Set(prev);
    if (next.has(l)) next.delete(l); else next.add(l);
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
    return next;
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <Segmented options={RANGES.map((r) => ({ value: r.sessions, label: r.label }))} value={sessions} onChange={setSessions} />
        <span className="text-ink-500">Kanal</span>
        <Segmented options={CHANNELS.map((c) => ({ value: c.sessions, label: c.label }))} value={channel} onChange={setChannel} />
        <LayerMenu layers={layers} onToggle={toggle} hasRead={!!read} />
      </div>
      <div className="rounded border border-ink-700 bg-ink-950 p-2">
        <PriceChart data={data} sessions={sessions} channel={channel} layers={layers} read={read} fmtPrice={fmtPrice} height={height} />
      </div>
    </div>
  );
}

/**
 * What is drawn over the candles, as a menu of checkboxes rather than nine
 * chips in a row above the chart: the chips were the busiest thing on the
 * page and the one least often touched.
 */
function LayerMenu({ layers, onToggle, hasRead }: { layers: ReadonlySet<ChartLayer>; onToggle: (l: ChartLayer) => void; hasRead: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const shown = CHART_LAYERS.filter((l) => l.key !== 'read' || hasRead);
  return (
    <div ref={root} className="relative ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="rounded border border-ink-700 bg-ink-900 px-2 py-0.5 text-ink-300 transition hover:bg-ink-800"
      >
        Einblenden <span className="text-ink-500">{shown.filter((l) => layers.has(l.key)).length}/{shown.length} ▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-ink-700 bg-ink-900 p-1.5 shadow-2xl">
          {shown.map((l) => (
            <label key={l.key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-ink-200 hover:bg-ink-800">
              <input type="checkbox" checked={layers.has(l.key)} onChange={() => onToggle(l.key)} className="accent-[var(--color-accent)]" />
              {l.label}
            </label>
          ))}
        </div>
      )}
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
