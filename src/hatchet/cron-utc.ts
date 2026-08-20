/**
 * Saying "midnight in Berlin" to a scheduler that only speaks UTC.
 *
 * Hatchet's cron API takes an expression and nothing else — no timezone field
 * exists in the SDK or the REST contract — so a cron installed there fires on
 * the engine's UTC clock. The admin page, meanwhile, offers a timezone and used
 * to have it honoured by node-cron. Left alone, "00:00 Europe/Berlin" would
 * quietly become 00:00 UTC: an hour or two off, and off in the other direction
 * half the year.
 *
 * So the expression is translated before it is installed. The translation is
 * deliberately narrow — it declines rather than guesses:
 *
 *   - Only when day-of-month and month are unrestricted. Shifting a date-bound
 *     schedule across midnight can move it into a different month, and "the 1st
 *     at 00:30 Berlin" has no honest fixed-UTC equivalent at all.
 *   - Only for whole-hour offsets. Half-hour zones (India, parts of Australia)
 *     would need the minute field moved too, and that interacts with ranges.
 *
 * What it cannot express, it leaves alone and says so, so the caller can keep
 * the in-process scheduler instead of installing something subtly wrong.
 *
 * The offset is the one in force *now*. A daily job therefore drifts by an hour
 * when the clocks change, until the next time the schedule is saved or the
 * process restarts. That is a known and bounded inaccuracy for a nightly batch,
 * and the alternative — a scheduler that re-writes its own cron twice a year —
 * is a worse thing to own.
 */

/** How far ahead of UTC a zone is, in minutes, at a given instant. */
export function offsetMinutes(timeZone: string, at: Date = new Date()): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  // Read the wall clock in that zone back as if it were UTC: the difference to
  // the real instant is the offset.
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second),
  );
  return Math.round((asIfUtc - at.getTime()) / 60_000);
}

/** Expand `*`, `a,b`, `a-b` and `*​/n` over a range into explicit values. */
function expand(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [spec, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;
    if (spec === '*') { lo = min; hi = max; }
    else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a; hi = b;
    } else {
      const v = Number(spec);
      if (!Number.isInteger(v)) return null;
      lo = v; hi = stepRaw ? max : v;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

export interface ConvertedCron {
  /** The expression to install, already in UTC. */
  expression: string;
  /** Offset applied, in minutes; 0 when the zone was already UTC. */
  offsetMinutes: number;
}

/**
 * Rewrite a 5-field cron from a timezone into UTC, or return null when it
 * cannot be done faithfully.
 */
export function cronToUtc(expression: string, timeZone: string, at: Date = new Date()): ConvertedCron | null {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];

  const offset = offsetMinutes(timeZone, at);
  if (offset === 0) return { expression, offsetMinutes: 0 };
  if (offset % 60 !== 0) return null;                 // half-hour zones: decline
  if (dom !== '*' || month !== '*') return null;      // date-bound: decline

  const hours = expand(hour, 0, 23);
  if (!hours) return null;

  const shift = offset / 60;
  // Re-sorted: cron does not care, but a readable expression is one you can
  // compare against the one in the settings without decoding it first.
  const shifted = hours.map((h) => ((h - shift) % 24 + 24) % 24).sort((a, b) => a - b);
  // Did the hours wrap to the previous or next day? Only then does the weekday
  // need moving, and only if the schedule restricts weekdays at all.
  const crossings = new Set(hours.map((h) => Math.floor((h - shift) / 24)));

  let utcDow = dow;
  if (dow !== '*') {
    if (crossings.size > 1) return null;              // some hours wrap, some do not
    const days = expand(dow, 0, 7);
    if (!days) return null;
    const delta = [...crossings][0] ?? 0;
    // cron accepts both 0 and 7 for Sunday; normalise before shifting.
    const norm = [...new Set(days.map((d) => d % 7))];
    utcDow = [...new Set(norm.map((d) => ((d + delta) % 7 + 7) % 7))].sort((a, b) => a - b).join(',');
  }
  return {
    expression: `${minute} ${shifted.join(',')} ${dom} ${month} ${utcDow}`,
    offsetMinutes: offset,
  };
}
