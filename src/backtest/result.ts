/**
 * What a backtest found, as stored for the page (`app_state`, `backtest.result`).
 *
 * Apart from the runner so that the server can read a result without loading
 * the SEC and Yahoo clients that produce one.
 */

import { readAppState } from '../db/admin.js';
import type { Evaluation } from '../analysis/evaluate.js';
import type { WeightValidation } from './weights.js';

export const RESULT_KEY = 'backtest.result';

export interface BacktestResult {
  generatedAt: string;
  from:        string;
  to:          string;
  /** Month-ends scored. */
  months:      number;
  /** Companies scored at least once. */
  companies:   number;
  /** "S&P 1500" or "S&P 500"; absent in results from before there was a choice (the 500). */
  universe?:   string;
  /**
   * The signals within each index of the composite — large, mid and small
   * caps — so a factor that works only further down is not averaged away.
   * Empty for a run on the 500 alone, absent in older results.
   */
  segments?:   { key: string; label: string; companies: number; ics: Evaluation['ics']; labels: Evaluation['labels'] }[];
  /** Median premium adjustment over the months, and its range. */
  premium:     { median: number; min: number; max: number };
  evaluation:  Evaluation;
  /**
   * The factor score's IC by calendar year, at one month, and the share of the
   * year's company-months with a rebuilt consensus target (absent in results
   * from before it was rebuilt, null in a run without it).
   */
  byYear:      { year: number; months: number; ic: number | null; neutralIc: number | null; analysts?: number | null }[];
  /** Companies that left the S&P 1500 since the start, and how many of them could be rebuilt; absent without. */
  departed?:   { departed: number; noFiler: number; noProfile: number; included: number };
  /** The weights fitted to it, and how the fit did on the months it had not seen. */
  fit:         WeightValidation;
  caveats:     string[];
}

export const BACKTEST_CAVEATS = [
  'Der Analystenkonsens ist aus Yahoos Rating-Historie rekonstruiert: je Haus das neueste Kursziel und Rating der zwölf Monate davor, '
    + 'ab drei Häusern. Vor 2020 ist die Historie dünner (Spalte „Konsens“ je Jahr). Schätzungen, Revisionen und Überraschungen gibt es '
    + 'rückwirkend nicht: Von „Erwartungen“ zählt nur die Rating-Veränderung, der DCF startet mit dem Wachstum der letzten zwölf Monate.',
  'Nur heutige Indexmitglieder, jedes ab seinem Aufnahmetag — wer den Index verlassen hat, fehlt (Survivorship). Für S&P 400 und 600 '
    + 'stammen die Aufnahmetage aus Wikipedias Wechseltabellen; wer dort nicht steht, zählt ab deren Beginn (S&P 600: Dezember 2019).',
  'Peer-Gruppen sind die GICS-Sub-Industries der Indexmitglieder, nicht die Finnhub-Gruppen.',
  'Kalibrierung und Prämienkorrektur werden je Monat nur aus dem Querschnitt dieses Monats bestimmt.',
];

/** Replaces the first caveat in a run made without the rebuilt consensus (`--no-analysts`). */
export const NO_ANALYSTS_CAVEAT =
  'Ohne Analystendaten gerechnet: Konsens und Erwartungen fehlen, der DCF startet mit dem Wachstum der letzten zwölf Monate.';

/** Replaces the survivorship caveat when the companies that left are in, as far as they could be found. */
export function departedCaveat(d: { departed: number; included: number }): string {
  return `Heutige Indexmitglieder ab ihrem Aufnahmetag, dazu ${d.included} der ${d.departed} Firmen, die den S&P 1500 seit 2013 `
    + 'verlassen haben, bis zu ihrem Austritt — die, die noch handeln und unter ihrem Ticker bei der SEC melden. Übernommene und insolvente '
    + 'Firmen fehlen weiter (Survivorship). Für S&P 400 und 600 stammen die Aufnahmetage aus Wikipedias Wechseltabellen; wer dort nicht '
    + 'steht, zählt ab deren Beginn (S&P 600: Dezember 2019).';
}

/** The newest stored result, or null before the first run. */
export async function storedBacktest(): Promise<BacktestResult | null> {
  try {
    const raw = await readAppState(RESULT_KEY);
    return raw ? JSON.parse(raw) as BacktestResult : null;
  } catch {
    return null;
  }
}

