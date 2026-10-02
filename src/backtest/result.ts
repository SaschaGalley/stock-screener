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
  /** Median premium adjustment over the months, and its range. */
  premium:     { median: number; min: number; max: number };
  evaluation:  Evaluation;
  /**
   * The factor score's IC by calendar year, at one month, and the share of the
   * year's company-months with a rebuilt consensus target (absent in results
   * from before it was rebuilt, null in a run without it).
   */
  byYear:      { year: number; months: number; ic: number | null; neutralIc: number | null; analysts?: number | null }[];
  /** The weights fitted to it, and how the fit did on the months it had not seen. */
  fit:         WeightValidation;
  caveats:     string[];
}

export const BACKTEST_CAVEATS = [
  'Der Analystenkonsens ist aus Yahoos Rating-Historie rekonstruiert: je Haus das neueste Kursziel und Rating der zwölf Monate davor, '
    + 'ab drei Häusern. Vor 2019 ist die Historie lückenhaft („Konsens“ je Jahr). Schätzungen, Revisionen und Überraschungen gibt es '
    + 'rückwirkend nicht: Von „Erwartungen“ zählt nur die Rating-Veränderung, der DCF startet mit dem Wachstum der letzten zwölf Monate.',
  'Nur heutige S&P-500-Mitglieder, jedes ab seinem Aufnahmetag — wer den Index verlassen hat, fehlt (Survivorship).',
  'Peer-Gruppen sind die GICS-Sub-Industries des Index, nicht die Finnhub-Gruppen.',
  'Kalibrierung und Prämienkorrektur werden je Monat nur aus dem Querschnitt dieses Monats bestimmt.',
];

/** Replaces the first caveat in a run made without the rebuilt consensus (`--no-analysts`). */
export const NO_ANALYSTS_CAVEAT =
  'Ohne Analystendaten gerechnet: Konsens und Erwartungen fehlen, der DCF startet mit dem Wachstum der letzten zwölf Monate.';

/** The newest stored result, or null before the first run. */
export async function storedBacktest(): Promise<BacktestResult | null> {
  try {
    const raw = await readAppState(RESULT_KEY);
    return raw ? JSON.parse(raw) as BacktestResult : null;
  } catch {
    return null;
  }
}

