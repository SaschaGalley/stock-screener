import { useState, type ReactNode } from 'react';
import type { NarrativeDimension, NarrativeDimensions, ScoreCard, ScoreCriterion, ScoreFinding, ScorePillar } from '../../types';
import { scoreBarColor, scoreColor } from '../stockList';
import { deNumber, verdictForScore } from '../../format';
import CheckMark, { type CheckMarkKind } from '../CheckMark';
import Term from '../Term';
import { DIMENSION_GLOSSARY, GLOSSARY, PILLAR_GLOSSARY } from '../../glossary';

/**
 * Why the number is the number — as a strip under the verdict.
 *
 * Every figure here is a stored field, so this is a rendering of the
 * calculation rather than a retelling of it. It used to be a section of its own
 * below the bull and bear case, open by default and three screens long: the
 * blend with two paragraphs of method, six pillars, every finding, and the two
 * summaries. What a reader wants at a glance is the arithmetic — how the two
 * halves met and what each pillar said — and that fits in one strip beside the
 * verdict it explains. The rest, findings and method and the two prose reads,
 * is one click away, and closed again the next time — a fold that remembered
 * being open stayed open for good.
 */
export default function ScoreBreakdown({ card }: { card: ScoreCard }) {
  const { factor, narrative } = card;
  const [details, setDetails] = useState(false);

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-ink-50">Wie der Score entsteht</h3>
        <button
          onClick={() => setDetails((x) => !x)}
          aria-expanded={details}
          className="flex items-center gap-1 text-xs text-ink-400 transition hover:text-ink-100"
        >
          {details ? 'Weniger' : 'Befunde & Begründung'}
          <span className={`text-ink-500 transition-transform ${details ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>

      <Formula card={card} />

      <div className="mt-3 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <GroupLabel dot="bg-sky-500">Zahlen · {factor.pillars.length} Säulen</GroupLabel>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            {factor.pillars.map((p) => <PillarCell key={p.key} p={p} />)}
          </div>
        </div>
        {narrative?.dimensions && (
          <div>
            <GroupLabel dot="bg-violet-500"><Term k="concept.dimension">Text · Geschäftslage laut Quellen</Term></GroupLabel>
            <Dimensions dimensions={narrative.dimensions} />
          </div>
        )}
      </div>

      {factor.caps.length > 0 && (
        <ul className="mt-3 space-y-0.5">
          {factor.caps.map((c, i) => (
            <li key={i} className="text-xs text-amber-400">⛔ {c.reason}</li>
          ))}
        </ul>
      )}

      {details && <Details card={card} />}
    </div>
  );
}

/**
 * The blend as one line and the width it actually had. The two halves carry
 * their prose as a tooltip, so the reading is a hover away even when the
 * details are closed.
 */
function Formula({ card }: { card: ScoreCard }) {
  const { factor, final, narrative, dataNote } = card;
  const fPct = Math.round(final.factorWeight * 100);
  const nPct = Math.round(final.narrativeWeight * 100);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 font-mono text-xs text-ink-400">
        <Term k="score.factor.score" extra={dataNote} className="text-sky-400">Zahlen {deNumber(factor.score, 1)}</Term>
        <Term k="score.final.factorWeight">× {fPct} %</Term>
        {narrative && (
          <>
            <span>+</span>
            <Term k="score.narrative.score" extra={narrative.summary} className="text-violet-400">
              Text {narrative.score === null ? 'Enthaltung' : deNumber(narrative.score, 1)}
            </Term>
            <span>× {nPct} %</span>
          </>
        )}
        <span>→ {deNumber(final.blend, 1)}</span>
        {final.adjustment !== 0 && (
          <Term k="score.final.adjustment" extra={final.adjustmentReason}>
            {final.adjustment > 0 ? '+' : '−'} {deNumber(Math.abs(final.adjustment), 1)} Korrektur
          </Term>
        )}
        <span>=</span>
        <span className={`text-sm font-bold ${scoreColor(final.score)}`}>{deNumber(final.score, 1)}</span>
        <span className="font-sans text-xs font-semibold text-ink-200">{final.verdict}</span>
        {/* Against the band of the *final* score, not the factor's: those two
            differ whenever the blend moved the number, which is not a cap. */}
        {verdictForScore(final.score) !== final.verdict && (
          <Term
            k="concept.capped"
            extra={`Der Score allein wäre ${verdictForScore(final.score)}.`}
            className="rounded border border-amber-700 px-1 font-sans text-3xs uppercase text-amber-400"
          >
            gedeckelt
          </Term>
        )}
      </div>
      <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-ink-800">
        <div className="bg-sky-500" style={{ width: `${fPct}%` }} title={`Zahlen ${fPct} %`} />
        <div className="bg-violet-500" style={{ width: `${nPct}%` }} title={`Text ${nPct} %`} />
      </div>
    </div>
  );
}

function GroupLabel({ dot, children }: { dot: string; children: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </div>
  );
}

function PillarCell({ p }: { p: ScorePillar }) {
  const width = p.score === null ? 0 : (p.score / 10) * 100;
  const criteria = (
    <>
      <ul className="space-y-0.5">
        {p.criteria.map((c) => (
          <li key={c.label}><span className="font-semibold text-ink-100">{c.label}:</span> {c.note}</li>
        ))}
      </ul>
      <div className="mt-1.5 text-ink-500">{GLOSSARY['concept.pillarCell']}</div>
    </>
  );
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <Term text={PILLAR_GLOSSARY[p.key]} extra={criteria} className="truncate text-ink-300">{p.label}</Term>
        <span className={`font-mono font-semibold ${scoreColor(p.score)}`}>
          {p.score === null ? '—' : deNumber(p.score, 1)}
        </span>
      </div>
      <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-ink-800">
        <div className={scoreBarColor(p.score)} style={{ width: `${width}%`, height: '100%' }} />
      </div>
      <div className="mt-0.5 font-mono text-2xs text-ink-500">
        {Math.round(p.effectiveWeight * 100)} % Gewicht · {passed(p)}/{p.criteria.length} ✓
        {p.coverage < 1 && <span className="text-amber-600"> · {Math.round(p.coverage * 100)} % Abdeckung</span>}
      </div>
    </div>
  );
}

const DIMENSION_LABELS: Record<NarrativeDimension, string> = {
  demand:     'Nachfrage',
  position:   'Position',
  execution:  'Ausführung',
  regulation: 'Regulierung',
  product:    'Produkt',
};

/** The five ratings the narrative score is computed from, each with its evidence on hover. */
function Dimensions({ dimensions }: { dimensions: NarrativeDimensions }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(DIMENSION_LABELS) as NarrativeDimension[]).map((key) => {
        const d = dimensions[key];
        const r = d?.rating;
        const cls = r == null ? 'border-ink-700 text-ink-500'
          : r > 0 ? 'border-emerald-700 text-emerald-400'
          : r < 0 ? 'border-red-800 text-red-400'
          : 'border-ink-600 text-ink-300';
        return (
          <Term
            key={key}
            text={DIMENSION_GLOSSARY[key]}
            extra={d?.note || 'Die Quellen sagen dazu nichts.'}
            className={`rounded border px-1.5 py-0.5 font-mono text-2xs ${cls}`}
          >
            {DIMENSION_LABELS[key]} {r == null ? '–' : r > 0 ? `+${r}` : r}
          </Term>
        );
      })}
    </div>
  );
}

/**
 * A criterion as a check. Points are centred on the reference universe, so
 * 0.5 is the typical stock: clearly above it passes, clearly below fails, and
 * the band between is neither — a checklist that called a 0.52 a pass would
 * be counting noise.
 */
function markOf(c: ScoreCriterion): CheckMarkKind {
  if (c.points === null) return 'none';
  return c.points >= 0.6 ? 'pass' : c.points <= 0.4 ? 'fail' : 'mixed';
}

const passed = (p: ScorePillar) => p.criteria.filter((c) => markOf(c) === 'pass').length;

const MARK_TITLE: Record<CheckMarkKind, string> = {
  pass:  'Klar besser als die typische Aktie',
  fail:  'Klar schlechter als die typische Aktie',
  mixed: 'Etwa wie die typische Aktie',
  none:  'Keine Daten — zählt nicht mit',
};

/**
 * Every criterion of every pillar as a sentence with a mark — the pillar bars
 * say how much, this says which. It used to live only in each bar's tooltip.
 */
function Checklist({ pillars }: { pillars: ScorePillar[] }) {
  return (
    <div>
      <Heading>Prüfliste</Heading>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
        {pillars.map((p) => (
          <div key={p.key}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
              <span className="font-semibold text-ink-200">{p.label}</span>
              <span className="font-mono text-ink-500">
                {passed(p)}/{p.criteria.length} ✓ · <span className={scoreColor(p.score)}>{p.score === null ? '—' : deNumber(p.score, 1)}</span>
              </span>
            </div>
            <ul className="space-y-1">
              {p.criteria.map((c) => {
                const kind = markOf(c);
                return (
                  <li key={c.key} className="flex gap-1.5 text-xs leading-snug">
                    <CheckMark kind={kind} title={MARK_TITLE[kind]} />
                    <span className={kind === 'none' ? 'text-ink-600' : 'text-ink-300'}>
                      <span className="text-ink-400">{c.label}:</span> {c.note}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Everything behind the strip: the checklist, which lines moved it, the two prose reads, the method. */
function Details({ card }: { card: ScoreCard }) {
  const { factor, final, narrative, dataNote } = card;
  return (
    <div className="mt-4 space-y-4 border-t border-ink-800 pt-4">
      <Checklist pillars={factor.pillars} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <Heading>Befunde</Heading>
          {factor.findings.length === 0
            ? <p className="text-xs text-ink-500">Keine Zeile bewegte den Score nennenswert.</p>
            : (
              <ul className="space-y-1">
                {factor.findings.map((f, i) => <FindingRow key={i} f={f} />)}
              </ul>
            )}
        </div>

        <div className="space-y-3">
          {dataNote && (
            <Note title="Zahlen" subtitle="fasst die Befunde zusammen, bewertet nicht">
              {dataNote}
            </Note>
          )}
          {narrative && (
            <Note
              title="Text"
              subtitle={`${narrative.sources.join(', ') || 'keine Quellen'} · ohne Kenntnis der Bewertung gelesen`
                + (narrative.spread != null ? ` · Median aus ${narrative.runs} Lesungen, Spanne ${deNumber(narrative.spread, 1)}` : '')}
            >
              {narrative.summary}
              {narrative.events.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-2xs text-ink-500">
                  {narrative.events.map((e, i) => <li key={i}>· {e}</li>)}
                </ul>
              )}
            </Note>
          )}
        </div>
      </div>

      <div className="space-y-1.5 text-xs leading-relaxed text-ink-500">
        {final.adjustmentReason && (
          <p className="rounded bg-ink-950 px-2 py-1 text-ink-300">
            <span className="text-ink-500">Korrektur:</span> {final.adjustmentReason}
          </p>
        )}
        <p>
          Die Gewichte sind die beiden Konfidenzen, keine Einstellung: Die
          Zahlen-Seite trägt {Math.round(factor.confidence * 100)} % Konfidenz aus
          Abdeckung, Composite-Konfidenz und Datenqualität. Schwache Daten geben
          der Prosa Gewicht, dünne Prosa gibt es den Zahlen zurück.
        </p>
        {/* Why this score sits where it does relative to 5 — the part a single
            digit cannot say, and the reason two stocks at 5.0 are not alike. */}
        <p>
          Rohwert {deNumber(factor.raw, 1)} · Vertrauen ×{deNumber(factor.shrink, 2)} ·
          Überzeugung ×{deNumber(factor.conviction, 2)} bei{' '}
          <span className="text-ink-300">{Math.round(factor.agreement * 100)} % Einigkeit</span> der Säulen.{' '}
          {factor.agreement >= 0.7
            ? 'Die Linsen ziehen in dieselbe Richtung — Bestätigung ist selbst ein Befund, und der Score darf entsprechend weit von 5 weg.'
            : factor.agreement >= 0.3
              ? 'Die Linsen sind sich teilweise uneins, der Score bleibt entsprechend näher an der Mitte.'
              : 'Die Linsen heben sich fast auf. Die Mitte ist hier ein echter Widerspruch zwischen starken Argumenten, kein blasses Urteil — siehe die Säulen.'}
        </p>
        <p>
          Kriterien ohne Daten werden fallen gelassen, die übrigen Gewichte neu
          normiert. Nichts wird mangels Wissens mit 5/10 bewertet — stattdessen
          sinkt die Abdeckung, und mit ihr die Konfidenz. Ein Haken heißt: klar
          besser als die typische Aktie des Referenzuniversums.
        </p>
      </div>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-500">
      {children}
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
    <li className="flex gap-1.5 text-xs leading-snug">
      <span className={`shrink-0 font-mono ${style.cls}`}>{style.mark}</span>
      <span className="text-ink-300">
        {(f.kind === 'driver' || f.kind === 'drag') && (
          <span className="mr-1 font-mono text-2xs text-ink-500">
            {f.impact >= 0 ? '+' : '−'}{deNumber(Math.abs(f.impact), 2)}
          </span>
        )}
        {f.note}
      </span>
    </li>
  );
}

function Note({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="rounded border border-ink-800 bg-ink-950 p-3">
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-500">
        {title} <span className="font-normal normal-case tracking-normal text-ink-500">— {subtitle}</span>
      </div>
      <div className="mt-1.5 text-xs leading-relaxed text-ink-300">{children}</div>
    </div>
  );
}
