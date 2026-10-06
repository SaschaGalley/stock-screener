import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useMoney } from '../../currency';
import type { MarketSignals, OverviewRow, TechnicalSignals, TimingReadings } from '../../types';
import type { ChartAnalysis, ChartReadDoc, ChartResponse } from '../../../../src/analysis/chart';
import { channelPlace, channelWay, roomAnswer, trendAnswer } from '../../../../src/analysis/chart-reading';
import Section from '../Section';
import ChartView from './ChartView';
import { ChartAnswers, LevelsAndNotables } from './Overview';
import ChartReadBlock, { readFinding } from './ChartReadBlock';
import TrendDetail from './TrendDetail';
import Entry, { entryFinding } from './Entry';
import Context, { contextFinding } from './Context';
import Indicators, { indicatorFinding } from './Indicators';
import { dayDe, de } from './shared';

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
  marketSignals?: MarketSignals | null;
}

/** "Mitte des steigenden 3-Monats-Kanals", "unten im fallenden 3-Monats-Kanal". */
function placeInChannel(c: ChartAnalysis['channels'][number]): string {
  const way = { steigend: 'steigenden', fallend: 'fallenden', seitwärts: 'seitwärts laufenden' }[channelWay(c)];
  const place = channelPlace(c);
  return place === 'Mitte' ? `Mitte des ${way} 3-Monats-Kanals`
    : place === 'darunter' ? `unter dem ${way} 3-Monats-Kanal`
    : place === 'darüber' ? `über dem ${way} 3-Monats-Kanal`
    : `${place} im ${way} 3-Monats-Kanal`;
}

/** The chart card's header line: which way, where in the channel, the room either way. */
function chartFinding(a: ChartAnalysis): string {
  const q = a.channels.find((c) => c.sessions === 63);
  const room = roomAnswer(a);
  return [
    trendAnswer(a).answer,
    q && placeInChannel(q),
    room?.answer,
  ].filter(Boolean).join(' · ');
}

/**
 * The chart and everything read from it, on one page in the order a reader
 * asks: the picture and four answers under it; where the floors and ceilings
 * are; what a model reads into it; the trend in detail; whether now is a
 * moment to buy; how the stock swings and stands against the market. Each
 * block answers its question in its header, so the page can be read down the
 * headers alone.
 *
 * The readings sat behind six tabs under the chart, each a table of numbers —
 * a click and a jump for every question, and no answer at the end of it.
 */
export default function ChartTab({ symbol, row, timing, signals, model, chartHeight, marketSignals = null }: Props) {
  const money = useMoney();
  const [data, setData] = useState<ChartResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
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

  const a = data?.analysis ?? null;
  const t = row?.timing ?? timing;
  const hasBars = !!data && data.bars.length > 0;

  return (
    <>
      <Section fixed title="Chart" info="section.technicals" finding={a ? chartFinding(a) : null} subtitle="Kurs, Kanal, Marken und Linien">
        {data === undefined && <p className="py-8 text-center text-sm text-ink-500">Lade Kursdaten …</p>}
        {error && <p className="text-sm text-red-400">⚠ {error}</p>}
        {data && !hasBars && <p className="text-sm text-ink-500">Keine Kursdaten im Archiv.</p>}
        {data && hasBars && <ChartView data={data} read={read?.read ?? null} fmtPrice={money.fmtPrice} height={chartHeight} />}
        {a && <div className="mt-4"><ChartAnswers a={a} lastMonth={t?.m1 ?? null} /></div>}
      </Section>

      {a && (
        <Section fixed title="Marken und Auffälligkeiten" info="tech.levels" finding={roomAnswer(a)?.answer ?? null}>
          <LevelsAndNotables a={a} fmtPrice={money.fmtPrice} />
        </Section>
      )}

      {hasBars && (
        <Section fixed title="KI-Chartlesung" info="tech.chartRead" finding={read ? readFinding(read.read) : null} subtitle="Ein Sprachmodell liest Muster, Marken und Szenarien">
          <ChartReadBlock
            symbol={symbol} model={model} read={read} price={a?.close ?? data!.bars.at(-1)!.close} asOf={a?.asOf ?? null}
            fmtPrice={money.fmtPrice} onRead={setRead}
          />
        </Section>
      )}

      {a && (
        <Section fixed title="Trend im Detail" info="tech.channels" finding={[trendAnswer(a).answer, ...trendAnswer(a).why.slice(0, 2)].join(' · ')}>
          <TrendDetail a={a} fmtPrice={money.fmtPrice} />
        </Section>
      )}

      {t && (
        <Section fixed title="Einstieg: Timing und Setups" finding={entryFinding(t, row)}>
          <Entry t={t} row={row} />
        </Section>
      )}

      {marketSignals && (
        <Section fixed title="Schwankung, Stärke und Umfeld" finding={contextFinding(marketSignals)}>
          <Context ms={marketSignals} />
        </Section>
      )}

      {signals && (
        <Section fixed title="Indikatoren" info="tech.vote" finding={indicatorFinding(signals)}>
          <Indicators signals={signals} />
        </Section>
      )}

      <p className="px-1 text-2xs leading-relaxed text-ink-500">
        Marken, Kanäle, Linien und Muster beschreiben den Chart; geprüft hat der Backtest davon nur die Timing-Lesungen und die Setups.
        Nichts hier fließt in Score oder Urteil ein. Gerechnet aus den archivierten, splitbereinigten Tageskursen
        {a ? `, Stand ${dayDe(a.asOf)}` : ''}{a?.atr ? `; eine übliche Tagesbewegung sind ${de((a.atr / a.close) * 100, 1)} %` : ''}.
      </p>
    </>
  );
}
