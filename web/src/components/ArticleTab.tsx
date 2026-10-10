import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ArticleResponse } from '../../../src/api-types';
import { recommendationColor } from '../format';
import { modelName } from '../models';

const dayDe = (iso: string | null | undefined) =>
  (iso ? new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '—');

/**
 * The report on a stock, as an investor magazine would print it: headline,
 * lead, five sections, conclusion — written on request from the newest
 * verdict, its pillars, the research and the chart reading
 * (`src/article-service.ts`), and kept until it is written again.
 */
export default function ArticleTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<ArticleResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    setData(null);
    setError(null);
    api.getArticle(symbol).then((d) => { if (!gone) setData(d); }).catch((e: Error) => { if (!gone) setError(e.message); });
    return () => { gone = true; };
  }, [symbol]);

  async function write() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { article } = await api.writeArticle(symbol);
      setData((d) => ({ analysisAt: d?.analysisAt ?? article.basis.analysisAt, article }));
    } catch (e) {
      setError((e as Error).message ?? 'Der Bericht ließ sich nicht schreiben.');
    } finally {
      setBusy(false);
    }
  }

  const a = data?.article ?? null;
  const stale = a && data?.analysisAt && data.analysisAt > a.basis.analysisAt;
  const button = (label: string) => (
    <button
      onClick={() => void write()}
      disabled={busy}
      className="rounded border border-ink-600 bg-ink-800 px-3 py-1 text-xs text-ink-100 transition hover:bg-ink-700 disabled:opacity-50"
    >
      {busy ? 'schreibt … (etwa eine Minute)' : label}
    </button>
  );

  if (data === null && !error) return <p className="text-xs text-ink-500">Lade Bericht …</p>;

  return (
    <div className="mx-auto max-w-3xl">
      {error && <p className="mb-3 rounded border border-red-800 bg-red-950 px-3 py-2 text-xs text-red-300">{error}</p>}

      {!a ? (
        <div className="rounded-lg border border-dashed border-ink-700 px-4 py-6 text-center">
          <p className="text-sm text-ink-200">Noch kein Bericht zu {symbol}.</p>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-ink-500">
            Ein Artikel wie in einem Anlegermagazin: Geschäft und Lage, die Zahlen, Bewertung und Analysten, der
            Chart, Pro und Contra, dazu Überschrift, Vorspann und Fazit. Geschrieben aus der neuesten Analyse, ihren
            Säulen, der Recherche und der Chartlesung — eine ältere als eine Woche wird dafür neu gelesen. Sechs
            Modellaufrufe, rund 15 Cent.
          </p>
          <div className="mt-3">{button('Bericht schreiben')}</div>
        </div>
      ) : (
        <article>
          {stale && (
            <p className="mb-3 rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
              Seit diesem Bericht gibt es eine neuere Analyse (vom {dayDe(data?.analysisAt)}). <span className="ml-1">{button('Neu schreiben')}</span>
            </p>
          )}
          <h2 className="text-2xl font-semibold leading-tight text-ink-50">{a.headline}</h2>
          <p className="mt-3 text-base font-medium leading-relaxed text-ink-200">{a.teaser}</p>
          <p className="mt-2 text-xs text-ink-500">
            Urteil der App: <span className={`font-semibold ${recommendationColor(a.basis.recommendation)}`}>{a.basis.recommendation}</span>
            {' '}· Score {a.basis.score.toFixed(1).replace('.', ',')} von 10
          </p>

          {a.sections.map((s) => (
            <section key={s.key} className="mt-6">
              <h3 className="text-lg font-semibold text-ink-100">{s.title}</h3>
              {s.text.split(/\n\s*\n/).map((para, i) => (
                <p key={i} className="mt-2 text-sm leading-relaxed text-ink-200">{para.trim()}</p>
              ))}
            </section>
          ))}

          <section className="mt-6 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
            <h3 className="text-lg font-semibold text-ink-100">Fazit</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-200">{a.conclusion}</p>
          </section>

          <footer className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-ink-800 pt-3 text-2xs text-ink-500">
            <span>
              Geschrieben am {dayDe(a.generatedAt)} von {modelName(a.model)} aus der Analyse vom {dayDe(a.basis.analysisAt)}
              {a.basis.chartAsOf && `, Chart bis ${dayDe(a.basis.chartAsOf)}`}
              {a.basis.briefAt && `, Recherche vom ${dayDe(a.basis.briefAt)}`}
              {a.costUsd !== null && ` · ${a.costUsd.toFixed(2).replace('.', ',')} $`}.
              {' '}Ein Sprachmodell hat ihn aus den Daten der App geschrieben; Urteil, Score und faire Spanne stammen aus der Rechnung. Keine Anlageberatung.
            </span>
            {!stale && button('Neu schreiben')}
          </footer>
        </article>
      )}
    </div>
  );
}
