import type { SignalGroup, SignalItem, TechnicalSignals } from '../../types';
import TechnicalGauge from '../charts/TechnicalGauge';
import { fmt } from '../../format';
import Term from '../Term';
import { technicalTerm } from '../../glossary';

interface Props {
  signals: TechnicalSignals;
}

export default function TechnicalSignalsPanel({ signals }: Props) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <TechnicalGauge title="Moving Averages" term="tech.movingAverages" group={signals.movingAverages} />
        <TechnicalGauge title="Oscillators"     term="tech.oscillators"     group={signals.oscillators} />
        <TechnicalGauge title="Overall"         term="tech.overall"         group={signals.overall} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <IndicatorTable title={`Moving Averages (${signals.movingAverages.items.length})`} group={signals.movingAverages} />
        <IndicatorTable title={`Oscillators (${signals.oscillators.items.length})`}        group={signals.oscillators} />
      </div>
    </div>
  );
}

function IndicatorTable({ title, group }: { title: string; group: SignalGroup }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-ink-300">
        {title}
      </h3>
      <table className="w-full text-xs tabular">
        <thead>
          <tr className="border-b border-ink-800 text-2xs uppercase tracking-wider text-ink-500">
            <th className="py-1 pr-2 text-left font-medium">Indicator</th>
            <th className="py-1 px-2 text-right font-medium">Value</th>
            <th className="py-1 pl-2 text-right font-medium">Signal</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((it: SignalItem) => (
            <tr key={it.name} className="border-b border-ink-800">
              <td className="py-1 pr-2 text-ink-300">
                <Term k={technicalTerm(it.name) ?? undefined} extra={it.hint && it.hint !== 'n/a' ? `Heute: ${it.hint}` : undefined}>
                  {it.name}
                </Term>
              </td>
              <td className="py-1 px-2 text-right font-mono text-ink-100">
                {it.value !== null ? fmt(it.value, '', 2) : '—'}
              </td>
              <td className="py-1 pl-2 text-right">
                <SignalBadge signal={it.signal} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignalBadge({ signal }: { signal: 'buy' | 'sell' | 'neutral' }) {
  const cls = signal === 'buy'
    ? 'bg-emerald-900 text-emerald-400'
    : signal === 'sell'
      ? 'bg-red-900 text-red-400'
      : 'bg-ink-800 text-ink-500';
  const label = signal.toUpperCase();
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-2xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}
