/**
 * The timing readings as stored: one series per field of their schema, under
 * the market signals' domain (`db/catalog.ts` derives them). The list reads the
 * newest of each, the live evaluation the newest before every month-end; both
 * put a refresh's readings back together here.
 */

import { TimingReadings, TimingReadingsSchema } from '../types.js';

const PREFIX = 'signals.technicals.timing.';

/** Every timing series key, one per field of the schema. */
export const TIMING_SERIES = Object.keys(TimingReadingsSchema.shape).map((k) => `${PREFIX}${k}`);

/** The month's return: never null, so the stamp every reading of one refresh shares. */
const ANCHOR = `${PREFIX}m1`;

/**
 * One refresh's readings from their points. Every field is written in the same
 * call, so a point not stamped like the anchor belongs to an earlier refresh
 * and is a field that has no value now.
 */
export function timingFromPoints(
  point: (key: string) => { at: string | Date; value: number | null } | null | undefined,
): TimingReadings | null {
  const stamp = point(ANCHOR)?.at;
  if (stamp === undefined) return null;
  const same = (at: string | Date) => new Date(at).getTime() === new Date(stamp).getTime();
  const parsed = TimingReadingsSchema.safeParse(Object.fromEntries(TIMING_SERIES.map((k) => {
    const p = point(k);
    return [k.slice(PREFIX.length), p && same(p.at) ? p.value : null];
  })));
  return parsed.success ? parsed.data : null;
}
