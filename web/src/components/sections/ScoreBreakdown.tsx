import type { ScoreCard, ScoreFinding, ScorePillar } from '../../types';
import { scoreBarColor, scoreColor } from '../stockList';
import { verdictForScore } from '../../format';

/**
 * Why the number is the number.
 *
 * The old verdict panel could show the score and the model that produced it,
 * and that was the whole of the provenance available — the reasoning existed
 * only inside one model call. Every figure here is a stored field, so this view
 * is a rendering of the calculation rather than a retelling of it.
 *
 * Ordering follows the arithmetic: the blend first (how the two halves met),
 * then the pillars (what the numbers said), then the findings (which individual
 * lines moved it, largest first). The findings are the same rows the summariser
 * was restricted to, so the prose above and the list below cannot drift apart.
 */
export default function ScoreBreakdown({ card }: { card: ScoreCard }) {
  const { factor, final, narrative, dataNote } = card;

  return (
    <div className="space-y-4">
      <BlendBar card={card} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <Heading>Säulen</Heading>
          <div className="space-y-1.5">
            {factor.pillars.map((p) => <PillarRow key={p.key} p={p} />)}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
            Kriterien ohne Daten werden fallen gelassen, die übrigen Gewichte neu
            normiert. Nichts wird mangels Wissens mit 5/10 bewertet — stattdessen
            sinkt die Abdeckung, und mit ihr die Konfidenz.
          </p>
        </div>

        <div>
          <Heading>Befunde</Heading>
          {factor.findings.length === 0
            ? <p className="text-[11px] text-ink-500">Keine Zeile bewegte den Score nennenswert.</p>
            : (
              <ul className="space-y-1">
                {factor.findings.map((f, i) => <FindingRow key={i} f={f} />)}
              </ul>
            )}
        </div>
      </div>

      {(dataNote || narrative) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {dataNote && (
            <Note title="Zahlen" subtitle="fasst die Befunde zusammen, bewertet nicht">
              {dataNote}
            </Note>
          )}
          {narrative && (
            <Note
              title="Text"
              subtitle={`${narrative.sources.join(', ') || 'keine Quellen'} · ohne Kenntnis der Bewertung gelesen`}
            >
              {narrative.summary}
              {narrative.events.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[10px] text-ink-500">
                  {narrative.events.map((e, i) => <li key={i}>· {e}</li>)}
                </ul>
              )}
            </Note>
          )}
        </div>
      )}
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
      {children}
    </div>
  );
}

function BlendBar({ card }: { card: ScoreCard }) {
  const { factor, final, narrative } = card;
  const fPct = Math.round(final.factorWeight * 100);
  const nPct = Math.round(final.narrativeWeight * 100);

  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`font-mono text-2xl font-bold tabular ${scoreColor(final.score)}`}>
          {final.score.toFixed(1)}
        </span>
        <span className="text-sm font-semibold text-ink-200">{final.verdict}</span>
        {/* Against the band of the *final* score, not the factor's: those two
            differ whenever the blend moved the number, which is not a cap. */}
        {verdictForScore(final.score) !== final.verdict && (
          <span
            className="rounded border border-amber-700 px-1 text-[9px] uppercase text-amber-400"
            title={`Der Score allein wäre ${verdictForScore(final.score)}`}
          >
            gedeckelt
          </span>
        )}
      </div>

      {/* The mixing ratio, as the width it actually had. */}
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div className="bg-sky-500" style={{ width: `${fPct}%` }} title={`Zahlen ${fPct} %`} />
        <div className="bg-violet-500" style={{ width: `${nPct}%` }} title={`Text ${nPct} %`} />
      </div>

      <div className="mt-1.5 font-mono text-[10px] text-ink-400">
        <span className="text-sky-400">Zahlen {factor.score.toFixed(1)}</span> × {fPct} %
        {narrative && (
          <>
            {' + '}
            <span className="text-violet-400">
              Text {narrative.score === null ? 'Enthaltung' : narrative.score.toFixed(1)}
            </span> × {nPct} %
          </>
        )}
        {' → '}{final.blend.toFixed(1)}
        {final.adjustment !== 0 && <> {final.adjustment > 0 ? '+' : '−'} {Math.abs(final.adjustment).toFixed(1)} Korrektur</>}
      </div>

      <p className="mt-1.5 text-[10px] leading-relaxed text-ink-500">
        Die Gewichte sind die beiden Konfidenzen, keine Einstellung: Die
        Zahlen-Seite trägt {Math.round(factor.confidence * 100)} % Konfidenz aus
        Abdeckung, Composite-Konfidenz und Datenqualität. Schwache Daten geben
        der Prosa Gewicht, dünne Prosa gibt es den Zahlen zurück.
      </p>

      {/* Why this score sits where it does relative to 5 — the part a single
          digit cannot say, and the reason two stocks at 5.0 are not alike. */}
      <p className="mt-1.5 text-[10px] leading-relaxed text-ink-500">
        Rohwert {factor.raw.toFixed(1)} · Vertrauen ×{factor.shrink.toFixed(2)} ·
        Überzeugung ×{factor.conviction.toFixed(2)} bei{' '}
        <span className="text-ink-300">{Math.round(factor.agreement * 100)} % Einigkeit</span> der Säulen.{' '}
        {factor.agreement >= 0.7
          ? 'Die Linsen ziehen in dieselbe Richtung — Bestätigung ist selbst ein Befund, und der Score darf entsprechend weit von 5 weg.'
          : factor.agreement >= 0.3
            ? 'Die Linsen sind sich teilweise uneins, der Score bleibt entsprechend näher an der Mitte.'
            : 'Die Linsen heben sich fast auf. Die Mitte ist hier ein echter Widerspruch zwischen starken Argumenten, kein blasses Urteil — siehe die Säulen links.'}
      </p>

      {final.adjustmentReason && (
        <p className="mt-1.5 rounded bg-ink-900 px-2 py-1 text-[10px] text-ink-300">
          <span className="text-ink-500">Korrektur:</span> {final.adjustmentReason}
        </p>
      )}

      {factor.caps.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {factor.caps.map((c, i) => (
            <li key={i} className="text-[10px] text-amber-400">⛔ {c.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PillarRow({ p }: { p: ScorePillar }) {
  const width = p.score === null ? 0 : (p.score / 10) * 100;
  const title = p.criteria
    .map((c) => `${c.label}: ${c.note}`)
    .join('\n');

  return (
    <div title={title}>
      <div className="flex items-baseline justify-between gap-2 font-mono text-[11px]">
        <span className="text-ink-300">{p.label}</span>
        <span className="text-ink-500">
          <span className={scoreColor(p.score)}>
            {p.score === null ? '—' : p.score.toFixed(1)}
          </span>
          {' · '}{Math.round(p.effectiveWeight * 100)} %
          {p.coverage < 1 && <span className="text-amber-600"> · {Math.round(p.coverage * 100)} % Abdeckung</span>}
        </span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-ink-800">
        <div
          className={scoreBarColor(p.score)}
          style={{ width: `${width}%`, height: '100%' }}
        />
      </div>
    </div>
  );
}

const FINDING_STYLE: Record<ScoreFinding['kind'], { mark: string; cls: string }> = {
  driver:     { mark: '▲', cls: 'text-emerald-400' },
  drag:       { mark: '▼', cls: 'text-red-400' },
  divergence: { mark: '⇄', cls: 'text-sky-400' },
  cap:        { mark: '⛔', cls: 'text-amber-400' },
  gap:        { mark: '⚠', cls: 'text-amber-500' },
};

function FindingRow({ f }: { f: ScoreFinding }) {
  const style = FINDING_STYLE[f.kind];
  return (
    <li className="flex gap-1.5 text-[11px] leading-snug">
      <span className={`shrink-0 font-mono ${style.cls}`}>{style.mark}</span>
      <span className="text-ink-300">
        {(f.kind === 'driver' || f.kind === 'drag') && (
          <span className="mr-1 font-mono text-[10px] text-ink-500">
            {f.impact >= 0 ? '+' : '−'}{Math.abs(f.impact).toFixed(2)}
          </span>
        )}
        {f.note}
      </span>
    </li>
  );
}

function Note({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {title} <span className="font-normal normal-case tracking-normal text-ink-600">— {subtitle}</span>
      </div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-ink-300">{children}</div>
    </div>
  );
}
