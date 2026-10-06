/**
 * The chart's reading as answers: four questions a reader brings to a chart —
 * which way, where in it, how much room, how much push — each answered in a
 * word, with the reasons in a line. The numbers stay where they are; this is
 * what they say.
 *
 * The chart section used to list the numbers — σ, ATR, R², "1 Wendepunkt" —
 * and leave the reading to the reader. Dependency-free, like `chart.ts`: the
 * page imports it across the package boundary.
 */

import { channelMove, type Channel, type ChartAnalysis, type ChartFinding, type PriceLevel } from './chart.js';

export type Tone = 'bull' | 'bear' | 'neutral';

export interface Answer {
  key:      string;
  question: string;
  answer:   string;
  tone:     Tone;
  /** The reasons, each a short phrase. */
  why:      string[];
}

const de = (x: number, d = 2) => x.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
const pct = (x: number, d = 1) => `${x >= 0 ? '+' : '−'}${de(Math.abs(x * 100), d)} %`;

/** A channel rising or falling by less than this a year (log) runs sideways — the list's threshold too. */
const FLAT = 0.15;
/** Within this many daily moves the price is at a level rather than short of it. */
const AT_LEVEL_ATR = 0.3;

export const channelWay = (c: Channel): 'steigend' | 'fallend' | 'seitwärts' =>
  c.slope > FLAT ? 'steigend' : c.slope < -FLAT ? 'fallend' : 'seitwärts';

/** Where in its channel the price is: the edges at one deviation, outside at two. */
export function channelPlace(c: Channel): 'unten' | 'Mitte' | 'oben' | 'darunter' | 'darüber' {
  return c.z < -2 ? 'darunter' : c.z > 2 ? 'darüber' : c.z <= -1 ? 'unten' : c.z >= 1 ? 'oben' : 'Mitte';
}

/** How well a straight channel describes the path: R² in words. */
export const channelFit = (c: Channel): 'sauber' | 'locker' | 'unscharf' =>
  c.r2 >= 0.6 ? 'sauber' : c.r2 >= 0.3 ? 'locker' : 'unscharf';

const CHANNEL_SPAN: Record<number, string> = { 63: '3 Monate', 126: '6 Monate', 252: '1 Jahr' };
export const channelSpan = (c: Channel) => CHANNEL_SPAN[c.sessions] ?? c.label;

const wayTone = (c: Channel): Tone => (channelWay(c) === 'steigend' ? 'bull' : channelWay(c) === 'fallend' ? 'bear' : 'neutral');

/** Which way: the averages, the channels and the turns, counted together. */
export function trendAnswer(a: ChartAnalysis): Answer {
  let votes = 0;
  const why: string[] = [];
  if (a.ma.stack === 'bull') { votes += 1; why.push('über allen drei Durchschnittslinien'); }
  else if (a.ma.stack === 'bear') { votes -= 1; why.push('unter allen drei Durchschnittslinien'); }
  else if (a.ma.sma200 !== null) {
    const over = a.close > a.ma.sma200;
    votes += over ? 0.5 : -0.5;
    why.push(`${over ? 'über' : 'unter'} der 200-Tage-Linie, die kürzeren uneinheitlich`);
  }
  for (const c of a.channels.filter((x) => x.sessions === 63 || x.sessions === 252)) {
    if (c.r2 < 0.3) continue;
    const way = channelWay(c);
    votes += way === 'steigend' ? 1 : way === 'fallend' ? -1 : 0;
    why.push(`${c.sessions === 63 ? '3-Monats-Kanal' : 'Jahreskanal'} ${way === 'seitwärts' ? 'läuft seitwärts' : way === 'steigend' ? 'steigt' : 'fällt'} (${pct(channelMove(c), 0)})`);
  }
  const st = a.structure;
  if (st.trend !== 'sideways') votes += st.trend === 'up' ? 1 : -1;
  else if (st.highs && st.lows) {
    const word = { higher: 'höhere', lower: 'tiefere', equal: 'gleich hohe' } as const;
    why.push(`zuletzt ${word[st.highs]} Hochs und ${word[st.lows]} Tiefs`);
  }
  const answer = votes >= 2 ? 'Aufwärts' : votes <= -2 ? 'Abwärts' : votes >= 1 ? 'Eher aufwärts' : votes <= -1 ? 'Eher abwärts' : 'Seitwärts';
  return { key: 'trend', question: 'Trend', answer, tone: votes >= 1 ? 'bull' : votes <= -1 ? 'bear' : 'neutral', why };
}

/** Where in the three-month channel. */
export function placeAnswer(a: ChartAnalysis): Answer | null {
  const c = a.channels.find((x) => x.sessions === 63);
  if (!c) return null;
  const way = channelWay(c);
  const place = channelPlace(c);
  const answer = place === 'darunter' ? 'Unter dem Kanal' : place === 'darüber' ? 'Über dem Kanal'
    : place === 'Mitte' ? 'Mitte des Kanals' : `${place === 'unten' ? 'Unten' : 'Oben'} im Kanal`;
  // The low edge of a rising channel is where it has turned up before; the high edge of a falling one, down.
  const tone: Tone = way === 'steigend' && (place === 'unten' || place === 'Mitte') ? 'bull'
    : way === 'fallend' && (place === 'oben' || place === 'Mitte') ? 'bear'
    : place === 'darunter' ? 'bear' : place === 'darüber' && way !== 'fallend' ? 'bull' : 'neutral';
  return {
    key: 'place', question: 'Lage', answer, tone,
    why: [
      `Kanal der letzten 3 Monate ${way === 'seitwärts' ? 'seitwärts' : way} (${pct(channelMove(c), 0)})`,
      `reicht heute von ${de(c.lower[1])} bis ${de(c.upper[1])}`,
      ...(channelFit(c) === 'unscharf' ? ['der Kurs folgt ihm nur lose'] : []),
    ],
  };
}

/** The nearest level each way, beyond the one the price may be standing on. */
export function nearestLevels(a: ChartAnalysis): { at: PriceLevel | null; support: PriceLevel | null; resistance: PriceLevel | null } {
  const at = a.levels.find((l) => l.distanceAtr !== null && Math.abs(l.distanceAtr) < AT_LEVEL_ATR) ?? null;
  return {
    at,
    support: a.levels.filter((l) => l.kind === 'support' && l !== at && l.distance < 0)[0] ?? null,
    resistance: a.levels.filter((l) => l.kind === 'resistance' && l !== at && l.distance > 0).at(-1) ?? null,
  };
}

/** How far to the next ceiling and floor, and which is nearer. */
export function roomAnswer(a: ChartAnalysis): Answer | null {
  const { at, support, resistance } = nearestLevels(a);
  if (!support && !resistance) return null;
  const why: string[] = [];
  if (at) why.push(`steht gerade an der Marke ${de(at.price)}`);
  if (resistance) why.push(`Widerstand bei ${de(resistance.price)}`);
  else why.push('kein Widerstand darüber — nahe am Hoch');
  if (support) why.push(`Unterstützung bei ${de(support.price)}`);
  else why.push('keine Unterstützung darunter');
  const answer = [resistance && `${pct(resistance.distance)} nach oben`, support && `${pct(support.distance)} nach unten`].filter(Boolean).join(', ');
  let tone: Tone = 'neutral';
  if (resistance && support) {
    const ratio = resistance.distance / -support.distance;
    tone = ratio >= 2 ? 'bull' : ratio <= 0.5 ? 'bear' : 'neutral';
    why.push(ratio >= 2 ? 'der Boden ist viel näher als die Decke' : ratio <= 0.5 ? 'die Decke ist viel näher als der Boden' : 'Decke und Boden etwa gleich weit');
  }
  return { key: 'room', question: 'Spielraum', answer, tone, why };
}

/** The RSI as a word: how hard the price has been pushed lately. */
export function rsiWord(rsi: number): { word: string; tone: Tone } {
  return rsi >= 70 ? { word: 'Heiß gelaufen', tone: 'bear' }
    : rsi >= 55 ? { word: 'Kräftig', tone: 'bull' }
    : rsi > 45 ? { word: 'Neutral', tone: 'neutral' }
    : rsi > 30 ? { word: 'Schwach', tone: 'bear' }
    : { word: 'Ausverkauft', tone: 'bull' };
}

/** How much push: the RSI, the last month, and a divergence where there is one. */
export function paceAnswer(a: ChartAnalysis, lastMonth: number | null = null): Answer | null {
  if (a.rsi14 === null) return null;
  const { word, tone: rsiTone } = rsiWord(a.rsi14);
  const why = [`RSI ${de(a.rsi14, 0)} (überkauft ab 70, überverkauft unter 30)`];
  if (lastMonth !== null) why.push(`${pct(lastMonth)} im letzten Monat`);
  const div = a.divergences.at(-1);
  if (div) why.push(div.kind === 'bearish' ? 'aber: neues Hoch ohne neuen Schwung (bärische Divergenz)' : 'aber: neues Tief ohne neuen Druck (bullische Divergenz)');
  // A divergence against the RSI's word takes the colour out of it.
  const tone: Tone = div && ((div.kind === 'bearish' && rsiTone === 'bull') || (div.kind === 'bullish' && rsiTone === 'bear')) ? 'neutral' : rsiTone;
  return { key: 'pace', question: 'Schwung', answer: word, tone, why };
}

export function chartAnswers(a: ChartAnalysis, lastMonth: number | null = null): Answer[] {
  return [trendAnswer(a), placeAnswer(a), roomAnswer(a), paceAnswer(a, lastMonth)].filter((x): x is Answer => x !== null);
}

/** Findings the answers and the price ladder already say, left out of the list beside them. */
const ANSWERED = new Set(['channel', 'channel-long', 'support', 'resistance', 'room', 'ma', 'rsi']);

/**
 * What else the chart shows — a break, a cross, a gap, a divergence — after
 * the answers. The trend's structure stays when it is a pattern of its own
 * (a narrowing range), not when it only repeats the trend.
 */
export function notableFindings(a: ChartAnalysis): ChartFinding[] {
  return a.findings.filter((f) => !ANSWERED.has(f.key) && (f.key !== 'structure' || a.structure.trend === 'sideways'));
}
