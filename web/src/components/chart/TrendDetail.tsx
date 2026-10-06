import type { ChartAnalysis } from '../../../../src/analysis/chart';
import { channelMove } from '../../../../src/analysis/chart';
import { channelFit, channelPlace, channelSpan, channelWay } from '../../../../src/analysis/chart-reading';
import Term from '../Term';
import Tip from '../Tip';
import { Question, RangeMarker, dayDe, de, pct } from './shared';

const FIT_HINT = {
  sauber:   'Der Kurs folgt der Linie eng',
  locker:   'Der Kurs schwankt deutlich um die Linie',
  unscharf: 'Eine gerade Linie beschreibt den Verlauf kaum',
} as const;

/**
 * The trend on three time scales and its lines: where in each channel the
 * price is, how far above or below its averages, the lines through its highs
 * and lows, and the marks a chart reader watches — each said in words with
 * its number beside it, where the table gave σ, R² and slopes.
 */
export default function TrendDetail({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      <div>
        <Question note="eine Gerade durch die Kurse, mit der üblichen Abweichung als Rändern"><Term k="tech.channels">In welchem Kanal läuft der Kurs?</Term></Question>
        <ul className="space-y-4">
          {a.channels.map((c) => {
            const way = channelWay(c);
            const place = channelPlace(c);
            const fit = channelFit(c);
            return (
              <li key={c.sessions}>
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="w-20 shrink-0 font-semibold text-ink-100">{channelSpan(c)}</span>
                  <span className={way === 'steigend' ? 'text-emerald-400' : way === 'fallend' ? 'text-red-400' : 'text-ink-300'}>
                    {way} {pct(channelMove(c), 0)}
                  </span>
                  <span className="text-ink-300">· Kurs {place === 'Mitte' ? 'in der Mitte' : place === 'darunter' ? 'unter dem Kanal' : place === 'darüber' ? 'über dem Kanal' : `${place} im Kanal`}</span>
                  <Tip focusable={false} content={`${FIT_HINT[fit]} (R² ${de(c.r2)}).`}>
                    <span className={`text-xs ${fit === 'unscharf' ? 'text-ink-500' : 'text-ink-400'}`}>· {fit}</span>
                  </Tip>
                </div>
                <RangeMarker
                  at={(c.z + 2) / 4}
                  left={<>unterer Rand <span className="font-mono text-ink-300">{fmtPrice(c.lower[1])}</span></>}
                  middle="Mitte"
                  right={<>oberer Rand <span className="font-mono text-ink-300">{fmtPrice(c.upper[1])}</span></>}
                />
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <Question note="wo der Kurs gegen den Schnitt der letzten Tage steht">Über oder unter den Durchschnitten?</Question>
        <MovingAverages a={a} fmtPrice={fmtPrice} />
      </div>

      {a.trendlines.length > 0 && (
        <div>
          <Question note="Geraden durch die letzten Wendepunkte"><Term k="tech.trendlines">Linien durch Hochs und Tiefs</Term></Question>
          <ul className="space-y-2 text-sm">
            {a.trendlines.map((t) => {
              const lows = t.kind === 'support';
              const d = t.now / a.close - 1;
              return (
                <li key={t.kind}>
                  <span className={lows ? 'text-emerald-400' : 'text-red-400'}>{lows ? 'Unter den Tiefs' : 'Über den Hochs'}</span>
                  <span className="text-ink-300">
                    {' '}vom {dayDe(t.from.day)} ({fmtPrice(t.from.price)}) zum {dayDe(t.to.day)} ({fmtPrice(t.to.price)}):{' '}
                    {t.broken
                      ? <>am {dayDe(t.brokenAt!)} {lows ? 'nach unten' : 'nach oben'} durchbrochen.</>
                      : <>heute bei <span className="font-mono text-ink-100">{fmtPrice(t.now)}</span>, {de(Math.abs(d * 100), 1)} % {d >= 0 ? 'über' : 'unter'} dem Kurs.</>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <Question>Marken, auf die viele achten</Question>
        <ul className="space-y-2 text-sm text-ink-300">
          {a.fibonacci && (
            <li>
              <Tip focusable={false} content="Nach einer großen Bewegung geben Kurse oft 38,2, 50 oder 61,8 % davon zurück, bevor sie weiterlaufen — weil viele Händler genau dort kaufen oder verkaufen.">
                <span className="text-ink-100">Rücksetzer-Marken</span>
              </Tip>{' '}
              der {a.fibonacci.dir === 'up' ? 'Aufwärtsbewegung' : 'Abwärtsbewegung'} {dayDe(a.fibonacci.from.day)}–{dayDe(a.fibonacci.to.day)}:
              <span className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5">
                {a.fibonacci.levels.filter((l) => [0.382, 0.5, 0.618].includes(l.ratio)).map((l) => (
                  <span key={l.ratio} className="whitespace-nowrap">{de(l.ratio * 100, 1)} % bei <span className="font-mono text-ink-100">{fmtPrice(l.price)}</span></span>
                ))}
              </span>
            </li>
          )}
          {a.profile && (
            <li>
              <Term k="tech.profile"><span className="text-ink-100">Hauptumsatzbereich</span></Term>: 70 % des Jahresvolumens zwischen{' '}
              <span className="font-mono text-ink-100">{fmtPrice(a.profile.valueLow)}</span> und <span className="font-mono text-ink-100">{fmtPrice(a.profile.valueHigh)}</span>,
              am meisten bei <span className="font-mono text-ink-100">{fmtPrice(a.profile.poc)}</span>; der Kurs liegt{' '}
              {a.close > a.profile.valueHigh ? 'darüber' : a.close < a.profile.valueLow ? 'darunter' : 'darin'}.
            </li>
          )}
          {a.squeeze && (
            <li>
              <span className="text-ink-100">Schwankungsband</span> (Bollinger) {de(a.squeeze.bandwidth * 100, 1)} % breit —{' '}
              {a.squeeze.percentile <= 0.1
                ? <>so eng wie selten im Jahr; danach kommt oft eine größere Bewegung.</>
                : <>enger als an {Math.round((1 - a.squeeze.percentile) * 100)} % der Tage des Jahres.</>}
            </li>
          )}
          {a.gaps.map((g) => (
            <li key={g.day}>
              <span className="text-ink-100">Offene Kurslücke</span> vom {dayDe(g.day)} {g.dir === 'up' ? 'nach oben' : 'nach unten'}:{' '}
              <span className="font-mono text-ink-100">{fmtPrice(g.low)}–{fmtPrice(g.high)}</span>, noch nicht wieder geschlossen.
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MovingAverages({ a, fmtPrice }: { a: ChartAnalysis; fmtPrice: (n: number) => string }) {
  const rows = ([[a.ma.sma20, '20 Tage'], [a.ma.sma50, '50 Tage'], [a.ma.sma200, '200 Tage']] as [number | null, string][])
    .filter((r): r is [number, string] => r[0] !== null);
  const span = Math.max(0.1, ...rows.map(([v]) => Math.abs(a.close / v - 1)));
  return (
    <div className="space-y-2.5">
      {rows.map(([v, label]) => {
        const d = a.close / v - 1;
        const w = (Math.abs(d) / span) * 50;
        return (
          <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span className="text-ink-300">{label}</span>
            <div className="relative h-2 rounded-full bg-ink-800">
              <div className="absolute inset-y-0 left-1/2 w-px bg-ink-600" />
              <div
                className={`absolute inset-y-0 rounded-full ${d >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
                style={d >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
              />
            </div>
            <span className="whitespace-nowrap text-right">
              <span className={d >= 0 ? 'text-emerald-400' : 'text-red-400'}>{de(Math.abs(d * 100), 1)} % {d >= 0 ? 'darüber' : 'darunter'}</span>
              <span className="ml-2 font-mono text-xs text-ink-500">{fmtPrice(v)}</span>
            </span>
          </div>
        );
      })}
      <p className="pt-1 text-[13px] text-ink-400">
        {a.ma.stack === 'bull' ? 'Die Linien liegen steigend übereinander — das typische Bild eines Aufwärtstrends.'
          : a.ma.stack === 'bear' ? 'Die Linien liegen fallend übereinander — das typische Bild eines Abwärtstrends.'
          : 'Die Linien liegen durcheinander — kein klares Trendbild.'}
        {a.ma.sma200Slope !== null && ` Die 200-Tage-Linie ${a.ma.sma200Slope > 0.005 ? 'steigt' : a.ma.sma200Slope < -0.005 ? 'fällt' : 'ist flach'} (${pct(a.ma.sma200Slope)} im letzten Monat).`}
        {a.ma.cross && ` Zuletzt ${a.ma.cross.kind === 'golden' ? 'Golden Cross (50 über 200)' : 'Death Cross (50 unter 200)'} am ${dayDe(a.ma.cross.day)}.`}
      </p>
    </div>
  );
}
