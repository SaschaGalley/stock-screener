import { useEffect, useState } from 'react';
import { api } from '../api';
import type { VerdictChangesResponse } from '../types';
import { RECOMMENDATIONS, deNumber, recommendationTone } from '../format';
import Tip from './Tip';

/** The newest move is the sentence; this many before it go into the hover. */
const EARLIER_SHOWN = 6;
/** A move this recent is still news, and gets the marker to say so. */
const FRESH_DAYS = 7;
const DAY_MS = 86_400_000;

type Change = VerdictChangesResponse['changes'][number];

/**
 * When this stock's verdict last moved to another band, as a sentence.
 *
 * It used to be a strip above the whole list — eight tickers with two chips
 * and an arrow each — which drew the eye on every visit and still left the
 * reader to work out what had happened. A move only means something next to
 * the stock it happened to, so it lives here now, under the verdict it
 * changed, in words: when, which way, how far the score went and what moved
 * it. The earlier moves are a hover away.
 */
export default function VerdictChanges({ symbol, refreshKey }: { symbol: string; refreshKey: number }) {
  const [changes, setChanges] = useState<Change[]>([]);

  useEffect(() => {
    let alive = true;
    setChanges([]);
    api.getVerdictChanges(EARLIER_SHOWN + 1, symbol)
      .then((r) => { if (alive) setChanges(r.changes); })
      .catch(() => { /* a missing line is not an error worth showing */ });
    return () => { alive = false; };
  }, [symbol, refreshKey]);

  const [last, ...earlier] = changes;
  if (!last) return null;
  const fresh = Date.now() - Date.parse(last.at) < FRESH_DAYS * DAY_MS;

  const scores = last.fromScore !== null && last.toScore !== null
    ? `Score ${deNumber(last.fromScore, 1)} → ${deNumber(last.toScore, 1)}, `
    : '';
  const sentence = (
    <>
      Urteil {when(last.at)} von <Label rec={last.from} /> auf <Label rec={last.to} /> {direction(last)}{' '}
      <span className="text-ink-500">({scores}{cause(last, true)}).</span>
    </>
  );

  // A paragraph rather than a row of flex items, so a narrow card wraps the
  // sentence under its own beginning instead of into a column beside a label.
  return (
    <p className="pt-3 text-xs leading-relaxed text-ink-400">
      <span
        aria-hidden
        className={`mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full align-middle ${fresh ? 'bg-amber-400' : 'bg-ink-600'}`}
      />
      {earlier.length === 0 ? sentence : (
        <Tip
          content={
            <>
              <div className="mb-1 font-semibold text-ink-100">Frühere Wechsel</div>
              <ul className="space-y-0.5">
                {earlier.map((c) => (
                  <li key={c.at}>
                    <span className="font-mono text-ink-400">{new Date(c.at).toLocaleDateString('de-DE')}</span>{' '}
                    <Label rec={c.from} /> → <Label rec={c.to} />
                    {c.fromScore !== null && c.toScore !== null && (
                      <span className="text-ink-400"> · {deNumber(c.fromScore, 1)} → {deNumber(c.toScore, 1)}</span>
                    )}
                    <span className="text-ink-500"> · {cause(c, false)}</span>
                  </li>
                ))}
              </ul>
            </>
          }
        >
          {sentence}{' '}
          <span className="whitespace-nowrap text-ink-500 underline decoration-dotted underline-offset-2">+{earlier.length} frühere</span>
        </Tip>
      )}
    </p>
  );
}

/** The label in its own colour — text, not a chip: it sits inside a sentence. */
function Label({ rec }: { rec: string }) {
  const tone = recommendationTone(rec);
  const cls = tone === 'positive' ? 'text-emerald-400' : tone === 'negative' ? 'text-red-400' : 'text-amber-400';
  return <span className={`font-semibold ${cls}`}>{rec}</span>;
}

/** Mid-sentence: „Urteil vor 3 Tagen …". */
function when(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / DAY_MS);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return `am ${new Date(iso).toLocaleDateString('de-DE')}`;
}

/** The verb says which way it went, so the reader need not rank two labels. */
function direction(c: Change): string {
  const rank = (v: string) => RECOMMENDATIONS.indexOf(v as (typeof RECOMMENDATIONS)[number]);
  return rank(c.to) < rank(c.from) ? 'angehoben' : 'gesenkt';
}

/** What moved it — as a clause in the sentence, or as a word in the list. */
function cause(c: Change, clause: boolean): string {
  if (c.source === 'analysis') return clause ? 'nach einer neuen Analyse' : 'Analyse';
  return clause ? 'nach einer Datenaktualisierung' : 'Datenaktualisierung';
}
