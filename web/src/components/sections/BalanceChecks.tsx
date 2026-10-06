import type { ComputedMetrics } from '../../types';
import CheckMark from '../CheckMark';
import Term from '../Term';

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
        <div>
          <h3 className="text-sm font-semibold text-ink-100"><Term k="concept.balanceChecks">Ist die Bilanz solide?</Term></h3>
          <p className={`text-sm ${passed === health.checks.length ? 'text-emerald-400' : passed >= health.checks.length / 2 ? 'text-ink-200' : 'text-red-400'}`}>
            {passed} von {health.checks.length} Prüfungen bestanden
          </p>
        </div>
        {runway !== null && (
          <Term
            k="concept.cashRunway"
            className={`font-mono text-xs ${runway >= 36 ? 'text-emerald-400' : runway >= 12 ? 'text-amber-400' : 'text-red-400'}`}
          >
            Cash-Runway {runway >= 120 ? '> 10 Jahre' : `${Math.round(runway)} Monate`}
          </Term>
        )}
      </div>
      <ul className="grid gap-x-8 gap-y-3 md:grid-cols-2">
        {health.checks.map((c) => (
          <li key={c.key} className="flex gap-2 leading-snug">
            <span className="mt-0.5"><CheckMark kind={c.mark} /></span>
            <div className="min-w-0">
              <div className="text-sm text-ink-100">{c.label}</div>
              <div className="text-[13px] text-ink-400">{c.note}</div>
            </div>
          </li>
        ))}
      </ul>
      {health.lender && (
        <p className="mt-2 text-xs text-ink-500">
          Kreditgeber: Liquiditäts- und Schulden-Checks entfallen, Schulden sind hier das Rohmaterial des Geschäfts.
        </p>
      )}
    </div>
  );
}
