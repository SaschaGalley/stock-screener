import type { ComputedMetrics } from '../../types';
import CheckMark from '../CheckMark';

/**
 * The balance sheet's plain questions, answered with the figures behind them
 * — and, for a company burning cash, how many months it has left. Computed
 * with the models (`src/analysis/health.ts`), so it is stored with them.
 */
export default function BalanceChecks({ health }: { health: ComputedMetrics['health'] | undefined }) {
  // Metrics stored before the checks existed carry none.
  if (!health || health.checks.length === 0) return null;
  const passed = health.checks.filter((c) => c.mark === 'pass').length;
  const runway = health.runwayMonths;

  return (
    <div className="mb-4 rounded border border-ink-800 bg-ink-950 p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
          Bilanz-Check · {passed}/{health.checks.length} ✓
        </div>
        {runway !== null && (
          <div
            className={`font-mono text-xs ${runway >= 36 ? 'text-emerald-400' : runway >= 12 ? 'text-amber-400' : 'text-red-400'}`}
            title="Cash geteilt durch den monatlichen Free-Cash-Flow-Abfluss der letzten zwölf Monate"
          >
            Cash-Runway {runway >= 120 ? '> 10 Jahre' : `${Math.round(runway)} Monate`}
          </div>
        )}
      </div>
      <ul className="grid gap-x-6 gap-y-1 md:grid-cols-2">
        {health.checks.map((c) => (
          <li key={c.key} className="flex gap-1.5 text-[11px] leading-snug">
            <CheckMark kind={c.mark} />
            <span className="text-ink-300">
              <span className="text-ink-200">{c.label}</span> — {c.note}
            </span>
          </li>
        ))}
      </ul>
      {health.lender && (
        <p className="mt-2 text-[10px] text-ink-500">
          Kreditgeber: Liquiditäts- und Schulden-Checks entfallen, Schulden sind hier das Rohmaterial des Geschäfts.
        </p>
      )}
    </div>
  );
}
