/**
 * A model's German prose with the numbers written the German way.
 *
 * The analyses are written in German, but their figures often come out the
 * English way — "$122.04", "64.5%", "2026-09-09", "$214B" — because the
 * inputs were. The stored texts are history and stay as they are; the page
 * writes them as the rest of it: "122,04 $", "64,5 %", "9.9.26", "214 Mrd. $".
 *
 * Only what is unambiguous is touched: an amount with its currency, a share
 * with its sign, a multiple with its x, a date with its dashes. A bare "3.10"
 * may be a German date and stays.
 */

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const SCALE: Record<string, string> = { K: 'Tsd.', M: 'Mio.', B: 'Mrd.', T: 'Bio.' };

/** "1,234" + "5" → "1.234,5" */
const de = (int: string, dec: string | undefined) => `${int.replace(/,/g, '.')}${dec ? `,${dec}` : ''}`;

export function deProse(s: string): string {
  if (!s) return s;
  return s
    // 2026-09-17 → 17.9.26
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y: string, m: string, d: string) => `${Number(d)}.${Number(m)}.${y.slice(2)}`)
    // $122.04, $214B, $1.2T → 122,04 $, 214 Mrd. $, 1,2 Bio. $
    .replace(new RegExp(String.raw`([−-]?)\$${NUM}(?:\s?([KMBT])\b)?`, 'g'),
      (_, sign: string, int: string, dec: string | undefined, scale: string | undefined) =>
        `${sign}${de(int, dec)}${scale ? ` ${SCALE[scale]}` : ''} $`)
    // 345.34 USD, 109.40 €  → 345,34 USD, 109,40 €
    .replace(new RegExp(String.raw`\b${NUM}(\s?)(USD|EUR|CHF|GBP|€)`, 'g'),
      (m, int: string, dec: string | undefined, sp: string, cur: string) => (dec ? `${de(int, dec)}${sp}${cur}` : m))
    // 64.5% → 64,5 %; 2.5pp → 2,5 Pp.
    // Whole numbers keep their spelling: "9%-11%" reads as a range either way.
    .replace(new RegExp(String.raw`\b${NUM}\s?(%|pp\b)`, 'g'),
      (m, int: string, dec: string | undefined, unit: string) => (dec || unit !== '%' ? `${de(int, dec)} ${unit === '%' ? '%' : 'Pp.'}` : m))
    // 28.58x → 28,58x
    .replace(new RegExp(String.raw`\b(\d+)\.(\d+)x\b`, 'g'), (_, int: string, dec: string) => `${int},${dec}x`);
}
