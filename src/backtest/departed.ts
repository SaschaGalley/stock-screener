/**
 * The companies that left the S&P 1500, as far as free data still has them.
 *
 * Today's members alone are survivors: a company that shrank out of the 600,
 * was bought or went bankrupt is missing, and with it most of what went wrong.
 * The index tables say who left and when (`departedMembers`). What can be
 * rebuilt is what still trades — a company that fell out of the 600 usually
 * does — and still files with the SEC under its ticker. A bought or bankrupt
 * company is gone from Yahoo, and stays missing; the result says how many.
 *
 * A ticker can belong to someone else by now — APC was Anadarko and is ARKO
 * — so the SEC's name for it must agree with the table's (`sameCompany`).
 * GICS is not in the tables; the sector and industry come from Yahoo's
 * profile, in Yahoo's vocabulary, which the live code reads anyway.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { lookupCIK } from '../data/edgar.js';
import { sameCompany, type Departed } from '../data/universe.js';
import { yahooWindow, yf } from './prices.js';

export interface DepartedResolution {
  companies: (Departed & { cik: string })[];
  /** Left since the start, rebuilt, and why the rest could not be. */
  counts: { departed: number; noFiler: number; noProfile: number; included: number };
}

async function profile(symbol: string, cacheDir: string): Promise<{ sector: string; industry: string } | null> {
  const file = join(cacheDir, `${symbol.replace(/[^A-Za-z0-9.^-]/g, '_')}.json`);
  if (existsSync(file)) {
    try { return (JSON.parse(readFileSync(file, 'utf8')) as { profile: { sector: string; industry: string } | null }).profile; } catch { /* again */ }
  }
  let found: { sector: string; industry: string } | null = null;
  try {
    await yahooWindow.take();
    const r = await yf.quoteSummary(symbol, { modules: ['assetProfile'] }, { validateResult: false });
    const p = r?.assetProfile;
    if (typeof p?.sector === 'string' && p.sector) found = { sector: p.sector, industry: typeof p.industry === 'string' ? p.industry : '' };
  } catch { /* gone from Yahoo */ }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), profile: found }));
  return found;
}

export async function resolveDeparted(departed: readonly Departed[], cacheDir: string): Promise<DepartedResolution> {
  const companies: (Departed & { cik: string })[] = [];
  let noFiler = 0, noProfile = 0;
  for (const d of departed) {
    const filer = await lookupCIK(d.symbol);
    if (!filer || !sameCompany(filer.name, d.name)) { noFiler++; continue; }
    const p = await profile(d.symbol, cacheDir);
    if (!p) { noProfile++; continue; }
    companies.push({ ...d, cik: filer.cik, sector: p.sector, subIndustry: p.industry });
  }
  return { companies, counts: { departed: departed.length, noFiler, noProfile, included: companies.length } };
}
