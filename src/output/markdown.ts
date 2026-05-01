import chalk from 'chalk';
import { AnalysisResult, BeneishResult, PiotroskiSignals, SectorMedians } from '../types.js';
import { fmt, fmtPct, fmtBig } from '../analysis/metrics.js';

export function formatMarkdown(r: AnalysisResult): string {
  const { financials: f, dcf, grahamNumber: gn, ratios, llmAnalysis: llm, news } = r;
  const { reverseDCF: rdcf, peterLynch: pl, evMultiples: ev, ruleOf40: r40,
          grahamRevised: gr, piotroski, altmanZ, ddm, epv, interestCoverage: ic,
          sortino, beneish, sectorMedians: sm } = r;

  const recColor = (rec: string) =>
    rec.includes('STRONG BUY') ? chalk.green.bold(rec) :
    rec.includes('BUY')        ? chalk.green(rec)       :
    rec.includes('HOLD')       ? chalk.yellow(rec)      :
    rec.includes('SELL')       ? chalk.red(rec)         : rec;

  const scoreBar = '█'.repeat(Math.round(llm.score)) + '░'.repeat(10 - Math.round(llm.score));

  const zoneColor = (z: string) =>
    z === 'safe' ? chalk.green(z) : z === 'distress' ? chalk.red(z) : chalk.yellow(z);

  const piotroskiBar = Object.entries(piotroski.signals)
    .map(([, v]) => v === null ? '?' : v ? '●' : '○')
    .join('');

  function row(label: string, value: string): string {
    return `| ${label.padEnd(22)} | ${value.padEnd(18)} |`;
  }

  const profileRows: string[] = [
    row('Company',       f.companyName),
    row('Symbol',        f.symbol),
    row('Sector',        [f.sector, f.industry].filter(Boolean).join(' / ') || 'N/A'),
  ];
  if (f.headquarters) profileRows.push(row('Headquarters', f.headquarters));
  if (f.employees)    profileRows.push(row('Employees',    f.employees.toLocaleString()));
  if (f.website)      profileRows.push(row('Website',      f.website));
  if (f.isin)         profileRows.push(row('ISIN',         f.isin));
  if (f.wkn)          profileRows.push(row('WKN',          f.wkn));

  const lines: string[] = [
    chalk.bold.white(`# ${r.symbol} — Investment Analysis`),
    chalk.gray(`${r.timestamp.replace('T', ' ').slice(0, 19)} UTC  |  ${r.provider}  |  search: ${r.searchProvider}`),
    '',

    chalk.bold('## 🏢 Company Profile'),
    '',
    `| ${'Field'.padEnd(22)} | ${''.padEnd(18)} |`,
    `|${'-'.repeat(24)}|${'-'.repeat(20)}|`,
    ...profileRows,
    '',
    ...(f.description ? [chalk.italic(
      f.description.length > 1000
        ? f.description.slice(0, 997) + '…'
        : f.description,
    ), ''] : []),

    chalk.bold('## 📊 Snapshot'),
    '',
    `| Metric                  | Value              |`,
    `|-------------------------|---------------------|`,
    row('Price',            `$${f.price.toFixed(2)}`),
    row('Market Cap',       fmtBig(f.marketCap)),
    row('Enterprise Value', fmtBig(ev.enterpriseValue)),
    row('52W High / Low',   `$${fmt(f.fiftyTwoWeekHigh)} / $${fmt(f.fiftyTwoWeekLow)}`),
    row('Beta',             fmt(f.beta)),
    '',

    ...formatKeyDates(f),

    ...formatPeerBlock(ratios, ev, f, sm),
    '',

    chalk.bold('## 📈 Profitability'),
    '',
    `| Metric             | Value        |  | Metric             | Value        |`,
    `|--------------------|--------------|--|--------------------|--------------|`,
    `| Revenue            | ${fmtBig(f.revenue).padEnd(12)} |  | Revenue Growth     | ${fmtPct(f.revenueGrowth).padEnd(12)} |`,
    `| Gross Profit       | ${fmtBig(f.grossProfit).padEnd(12)} |  | Earnings Growth    | ${fmtPct(f.earningsGrowth).padEnd(12)} |`,
    `| EBITDA             | ${fmtBig(f.ebitda).padEnd(12)} |  | Operating Margin   | ${fmtPct(f.operatingMargin).padEnd(12)} |`,
    `| Free Cash Flow     | ${fmtBig(f.freeCashFlow).padEnd(12)} |  | Net Margin         | ${fmtPct(f.netMargin).padEnd(12)} |`,
    `| ROE                | ${fmtPct(ratios.roe).padEnd(12)} |  | ROA                | ${fmtPct(ratios.roa).padEnd(12)} |`,
    `| ROIC               | ${fmtPct(f.roic).padEnd(12)} |  | EPS Growth 3Y      | ${fmtPct(f.epsGrowth3Y).padEnd(12)} |`,
    '',

    chalk.bold('## 🏦 Balance Sheet & Liquidity'),
    '',
    `| Metric             | Value        |  | Metric             | Value        |`,
    `|--------------------|--------------|--|--------------------|--------------|`,
    `| Total Cash         | ${fmtBig(f.totalCash).padEnd(12)} |  | Total Debt         | ${fmtBig(f.totalDebt).padEnd(12)} |`,
    `| Working Capital    | ${fmtBig(f.workingCapital).padEnd(12)} |  | Long-term Debt     | ${fmtBig(f.longTermDebt).padEnd(12)} |`,
    `| Current Ratio      | ${fmt(f.currentRatio, 'x').padEnd(12)} |  | Quick Ratio        | ${fmt(f.quickRatio, 'x').padEnd(12)} |`,
    `| Debt / Equity      | ${fmt(f.debtToEquity, 'x').padEnd(12)} |  | Interest Coverage  | ${ic.ratio ? `${ic.ratio.toFixed(1)}x`.padEnd(12) : `${ic.interpretation}`.padEnd(12)} |`,
    '',

    chalk.bold('## 📐 Intrinsic Value Models'),
    '',
    `| Model                   | Fair Value          | vs. Price            |`,
    `|-------------------------|---------------------|----------------------|`,
    fvRow('DCF (5yr, 10% growth)',  dcf.fairValue,       f.price),
    fvRow('Graham Number',          gn.grahamNumber,     f.price),
    fvRow('Graham Revised (V*)',     gr.fairValue,        f.price),
    fvRow('Peter Lynch',            pl.fairValue,        f.price),
    fvRow('EPV (Greenwald)',         epv.fairValue,       f.price),
    fvRow('DDM (Gordon Growth)',     ddm.isApplicable ? ddm.fairValue ?? null : null, f.price, ddm.isApplicable ? undefined : 'no dividend'),
    '',

    chalk.bold('## 🔄 Reverse DCF'),
    '',
    rdcf.isPossible && rdcf.impliedGrowthRate !== null
      ? [
          `  Implied FCF Growth: ${chalk.bold((rdcf.impliedGrowthRate * 100).toFixed(1) + '%/yr')}`,
          `  ${rdcf.interpretation}`,
        ].join('\n')
      : `  ${rdcf.interpretation}`,
    '',

    chalk.bold('## ⚡ Rule of 40' + (f.sector?.match(/Tech|Software|Commun/) ? ' (SaaS metric)' : '')),
    '',
    r40.score !== null
      ? [
          `  Revenue Growth:  ${r40.revenueGrowthPct?.toFixed(1)}%`,
          `  Profit Margin:   ${r40.profitMarginPct?.toFixed(1)}%`,
          `  Score:           ${chalk[r40.passes ? 'green' : 'yellow'](r40.score.toFixed(1))} / 40  ${r40.passes ? '(PASSES ✓)' : '(FAILS ✗)'}`,
        ].join('\n')
      : '  N/A — missing data',
    '',

    ...formatEarningsSurprises(f),

    chalk.bold('## 🏆 Piotroski F-Score'),
    '',
    ...formatPiotroski(piotroski.signals, piotroski.score, piotroski.maxScore, piotroskiBar, piotroski.interpretation),
    '',

    chalk.bold('## ⚠️  Altman Z-Score'),
    '',
    altmanZ.score !== null
      ? [
          `  Score: ${chalk.bold(altmanZ.score.toFixed(2))}  →  ${zoneColor(altmanZ.zone)} zone`,
          `  Model: ${altmanZ.model} (thresholds: safe >${altmanZ.thresholds.safe}, distress <${altmanZ.thresholds.distress})`,
          `  X1 (Working Cap/Assets):   ${altmanZ.x1?.toFixed(3) ?? 'N/A'}`,
          `  X2 (Retained E./Assets):   ${altmanZ.x2?.toFixed(3) ?? 'N/A'}`,
          `  X3 (EBIT/Assets):          ${altmanZ.x3?.toFixed(3) ?? 'N/A'}`,
          `  X4 (Mkt Cap/Liabilities):  ${altmanZ.x4?.toFixed(3) ?? 'N/A'}`,
          altmanZ.model === 'original' ? `  X5 (Revenue/Assets):      ${altmanZ.x5?.toFixed(3) ?? 'N/A'}` : '',
        ].filter(Boolean).join('\n')
      : '  N/A — missing balance sheet data',
    '',

    chalk.bold('## 📉 Sortino Ratio'),
    '',
    sortino.ratio !== null
      ? [
          `  Ratio:             ${chalk.bold(sortino.ratio.toFixed(2))}  (${sortino.interpretation})`,
          `  Annual Return:     ${fmtPct(sortino.annualReturn)}`,
          `  Downside Dev:      ${fmtPct(sortino.downsideDeviation)} annualised`,
          `  Risk-Free Rate:    ${(sortino.riskFreeRate * 100).toFixed(1)}%`,
        ].join('\n')
      : '  N/A — insufficient price history (needs ≥6 months)',
    '',

    chalk.bold('## 🔍 Beneish M-Score'),
    '',
    beneish.score !== null
      ? [
          `  Score: ${chalk.bold(beneish.score.toFixed(2))}  →  ${formatBeneishProbability(beneish.probability)}`,
          `  Variables: ${beneish.variablesComputed}/8 computed${beneish.variablesComputed < 8 ? ' (missing used neutral=1.0)' : ''}`,
          `  DSRI  ${fmt(beneish.dsri, '', 3).padEnd(8)} Days Sales Receivable Index  (>1 = receivables growing faster than sales)`,
          `  GMI   ${fmt(beneish.gmi, '', 3).padEnd(8)} Gross Margin Index           (>1 = margin deteriorating)`,
          `  AQI   ${fmt(beneish.aqi, '', 3).padEnd(8)} Asset Quality Index          (>1 = more intangible assets)`,
          `  SGI   ${fmt(beneish.sgi, '', 3).padEnd(8)} Sales Growth Index           (>1 = high growth, manipulation pressure)`,
          `  DEPI  ${fmt(beneish.depi, '', 3).padEnd(8)} Depreciation Index          (>1 = slower depreciation)`,
          `  SGAI  ${fmt(beneish.sgai, '', 3).padEnd(8)} SG&A Index                  (>1 = expenses growing faster than sales)`,
          `  TATA  ${fmt(beneish.tata, '', 3).padEnd(8)} Total Accruals/Assets       (>0 = accrual-heavy earnings)`,
          `  LVGI  ${fmt(beneish.lvgi, '', 3).padEnd(8)} Leverage Index              (>1 = increasing leverage)`,
        ].join('\n')
      : '  N/A — insufficient balance sheet data',
    '',

    ...formatAnalystBlock(f),
    '',

    ...formatShortInterest(f),
    ...formatOwnership(f),
    ...formatInsiderActivity(f),

    chalk.bold('## 🚀 Bull Case'),
    '',
    llm.bullCase,
    '',
    chalk.bold('## 🐻 Bear Case'),
    '',
    llm.bearCase,
    '',
    chalk.bold('## ⚠️  Key Risks'),
    '',
    ...llm.keyRisks.map((risk) => `  • ${risk}`),
    '',
    chalk.bold('## 💡 Investment Thesis'),
    '',
    llm.thesis,
    '',
    chalk.bold('## 📊 Recommendation'),
    '',
    `  Score:          ${scoreBar} ${llm.score}/10`,
    `  Recommendation: ${recColor(llm.recommendation)}`,
    `  Fair Value Est: ${llm.fairValueEstimate}`,
  ];

  if (news.length > 0) {
    lines.push('', chalk.bold('## 📰 Recent News'), '');
    news.slice(0, 5).forEach((n) => {
      const date = new Date(n.datetime * 1000).toLocaleDateString('de-DE');
      lines.push(`  [${date}] ${n.headline} — ${chalk.gray(n.source)}`);
    });
  }

  lines.push('', chalk.gray('───────────────────────────────────────────'));
  lines.push(chalk.gray('Data: Yahoo Finance · Finnhub'));

  return lines.join('\n');
}

function formatPeerBlock(
  ratios: AnalysisResult['ratios'],
  ev: AnalysisResult['evMultiples'],
  f: AnalysisResult['financials'],
  sm: SectorMedians | null,
): string[] {
  if (!sm) {
    // No peer data — plain 2-column multiples table
    return [
      chalk.bold('## 💹 Valuation Multiples'),
      '',
      `| Multiple       | Value    |  | Multiple       | Value    |`,
      `|----------------|----------|--|----------------|----------|`,
      `| P/E            | ${fmt(ratios.pe, 'x').padEnd(8)} |  | EV/EBITDA      | ${fmt(ev.evToEbitda, 'x').padEnd(8)} |`,
      `| Forward P/E    | ${fmt(ratios.forwardPE, 'x').padEnd(8)} |  | EV/Revenue     | ${fmt(ev.evToRevenue, 'x').padEnd(8)} |`,
      `| PEG            | ${fmt(ratios.peg).padEnd(8)} |  | EV/FCF         | ${fmt(ev.evToFCF, 'x').padEnd(8)} |`,
      `| P/B            | ${fmt(ratios.pb, 'x').padEnd(8)} |  | P/FCF          | ${fmt(ev.priceToFCF, 'x').padEnd(8)} |`,
      `| P/S            | ${fmt(ev.priceToSales, 'x').padEnd(8)} |  | Div. Yield     | ${fmtPct(f.dividendYield).padEnd(8)} |`,
    ];
  }

  const peerNames = sm.peers.slice(0, 5).join(', ') + (sm.peers.length > 5 ? '…' : '');

  // vs column: lowerBetter=true → above median is bad (red), below is good (green)
  const vsCol = (val: number | null, median: number | null, lowerBetter: boolean): string => {
    if (val === null || median === null || median === 0) return '—'.padEnd(18);
    const pct = ((val - median) / Math.abs(median)) * 100;
    const sign = pct >= 0 ? '+' : '';
    const label = `${sign}${pct.toFixed(0)}%`;
    const isGood  = lowerBetter ? pct < -15 : pct > 15;
    const isBad   = lowerBetter ? pct >  30 : pct < -20;
    const colored = isBad ? chalk.red(label) : isGood ? chalk.green(label) : chalk.yellow(label);
    return `${fmt(median, lowerBetter ? 'x' : '', 1).padEnd(8)} ${colored}`;
  };
  const vsColPct = (val: number | null, median: number | null, lowerBetter: boolean): string => {
    if (val === null || median === null || median === 0) return '—'.padEnd(18);
    const pct = ((val - median) / Math.abs(median)) * 100;
    const sign = pct >= 0 ? '+' : '';
    const label = `${sign}${pct.toFixed(0)}%`;
    const isGood  = lowerBetter ? pct < -15 : pct > 10;
    const isBad   = lowerBetter ? pct >  30 : pct < -20;
    const colored = isBad ? chalk.red(label) : isGood ? chalk.green(label) : chalk.yellow(label);
    return `${fmtPct(median).padEnd(8)} ${colored}`;
  };

  const row = (label: string, val: string, medianCol: string) =>
    `| ${label.padEnd(18)} | ${val.padEnd(10)} | ${medianCol} |`;

  return [
    chalk.bold(`## 🔬 vs Peer Group`) + chalk.gray(`  (${sm.peerCount} cos: ${peerNames})`),
    '',
    `| Metric             | Value      | Peer Median + Δ    |`,
    `|--------------------|------------|---------------------|`,
    // ── Valuation ──
    row('P/E',              fmt(ratios.pe,          'x', 1), vsCol(ratios.pe,          sm.pe,               true)),
    row('Forward P/E',      fmt(ratios.forwardPE,   'x', 1), '—'.padEnd(18)),
    row('EV/EBITDA',        fmt(ev.evToEbitda,      'x', 1), vsCol(ev.evToEbitda,      sm.evToEbitda,       true)),
    row('EV/Revenue',       fmt(ev.evToRevenue,     'x', 1), vsCol(ev.evToRevenue,     sm.evToRevenue,      true)),
    row('P/FCF',            fmt(ev.priceToFCF,      'x', 1), vsCol(ev.priceToFCF,      sm.priceToFCF,       true)),
    row('P/B',              fmt(ratios.pb,          'x', 1), vsCol(ratios.pb,          sm.pb,               true)),
    // ── Profitability ──
    row('Operating Margin', fmtPct(f.operatingMargin),       vsColPct(f.operatingMargin, sm.operatingMargin, false)),
    row('Net Margin',       fmtPct(f.netMargin),             vsColPct(f.netMargin,       sm.netMargin,       false)),
    row('ROE',              fmtPct(f.roe),                   vsColPct(f.roe,             sm.roe,             false)),
    row('ROIC',             fmtPct(f.roic),                  vsColPct(f.roic,            sm.roic,            false)),
    // ── Growth ──
    row('Revenue Growth',   fmtPct(f.revenueGrowth),        vsColPct(f.revenueGrowth,   sm.revenueGrowthYoY, false)),
  ];
}

function formatAnalystBlock(f: AnalysisResult['financials']): string[] {
  const total = (f.analystStrongBuy ?? 0) + (f.analystBuy ?? 0)
              + (f.analystHold ?? 0) + (f.analystSell ?? 0) + (f.analystStrongSell ?? 0);

  if (!f.targetMeanPrice && total === 0) return [];

  const lines: string[] = [chalk.bold('## 🎯 Analyst Consensus'), ''];

  // Price target row
  if (f.targetMeanPrice) {
    const mosPct = ((f.targetMeanPrice - f.price) / f.price * 100);
    const updown = mosPct >= 0
      ? chalk.green(`▲ ${mosPct.toFixed(1)}% upside`)
      : chalk.red(`▼ ${Math.abs(mosPct).toFixed(1)}% downside`);
    lines.push(
      `  Price Target:   ${chalk.bold('$' + f.targetMeanPrice.toFixed(2))} avg  ${updown}${f.analystCount ? `  (${f.analystCount} analysts)` : ''}`,
    );
    if (f.analystTargetLow !== null && f.analystTargetHigh !== null) {
      lines.push(`  Range:          $${f.analystTargetLow.toFixed(2)} – $${f.analystTargetHigh.toFixed(2)}` +
        (f.analystTargetMedian ? `  |  median $${f.analystTargetMedian.toFixed(2)}` : ''));
    }
  }

  // Rating breakdown bar
  if (total > 0) {
    const sb = f.analystStrongBuy  ?? 0;
    const b  = f.analystBuy        ?? 0;
    const h  = f.analystHold       ?? 0;
    const s  = f.analystSell       ?? 0;
    const ss = f.analystStrongSell ?? 0;
    const bar = [
      chalk.green('█').repeat(sb),
      chalk.green('▓').repeat(b),
      chalk.yellow('░').repeat(h),
      chalk.red('▓').repeat(s),
      chalk.red('█').repeat(ss),
    ].join('');
    const buyPct = Math.round(((sb + b) / total) * 100);
    lines.push(
      '',
      `  Ratings:        [${bar}]`,
      `  ${chalk.green(`Strong Buy: ${sb}  Buy: ${b}`)}  ${chalk.yellow(`Hold: ${h}`)}  ${chalk.red(`Sell: ${s}  Strong Sell: ${ss}`)}  →  ${chalk.bold(buyPct + '% bullish')}`,
    );
  }

  return lines;
}

function formatKeyDates(f: AnalysisResult['financials']): string[] {
  const items: string[] = [];
  if (f.nextEarningsDate) items.push(`  Next Earnings:    ${chalk.bold(f.nextEarningsDate)}`);
  if (f.exDividendDate) {
    const divLine = `  Ex-Dividend:      ${chalk.bold(f.exDividendDate)}`
      + (f.nextDividendAmount ? `   $${f.nextDividendAmount.toFixed(2)}/share` : '');
    items.push(divLine);
  }
  if (f.dividendPayDate)  items.push(`  Pay Date:         ${f.dividendPayDate}`);
  if (items.length === 0) return [];
  return [chalk.bold('## 📅 Key Dates'), '', ...items, ''];
}

function formatEarningsSurprises(f: AnalysisResult['financials']): string[] {
  const es = f.earningsSurprises;
  if (!es || es.length === 0) return [];

  const lines: string[] = [chalk.bold('## 🎯 Earnings Surprises'), ''];
  lines.push(`| ${'Quarter'.padEnd(8)} | ${'Estimate'.padEnd(9)} | ${'Actual'.padEnd(9)} | ${'Surprise'.padEnd(10)} |`);
  lines.push(`|${'-'.repeat(10)}|${'-'.repeat(11)}|${'-'.repeat(11)}|${'-'.repeat(12)}|`);

  for (const q of es) {
    const est = q.epsEstimate !== null ? `$${q.epsEstimate.toFixed(2)}` : 'N/A';
    const act = q.epsActual   !== null ? `$${q.epsActual.toFixed(2)}`   : 'N/A';
    let surp = 'N/A';
    if (q.surprisePct !== null) {
      const pct = (q.surprisePct * 100).toFixed(1);
      surp = q.surprisePct >= 0
        ? chalk.green(`✓ +${pct}%`)
        : chalk.red(`✗ ${pct}%`);
    }
    lines.push(`| ${q.quarter.padEnd(8)} | ${est.padEnd(9)} | ${act.padEnd(9)} | ${surp.padEnd(10)} |`);
  }
  lines.push('');
  return lines;
}

function formatShortInterest(f: AnalysisResult['financials']): string[] {
  if (f.shortPercentOfFloat === null && f.shortRatio === null) return [];
  const lines: string[] = [chalk.bold('## 🩳 Short Interest'), ''];

  if (f.shortPercentOfFloat !== null) {
    const pct = (f.shortPercentOfFloat * 100).toFixed(1) + '%';
    let trend = '';
    if (f.sharesShort !== null && f.sharesShortPriorMonth !== null && f.sharesShortPriorMonth > 0) {
      const chg = ((f.sharesShort - f.sharesShortPriorMonth) / f.sharesShortPriorMonth * 100);
      trend = chg >= 0
        ? chalk.red(`  ▲ ${chg.toFixed(0)}% vs prior month`)
        : chalk.green(`  ▼ ${Math.abs(chg).toFixed(0)}% vs prior month`);
    }
    const level = f.shortPercentOfFloat > 0.20 ? chalk.red(pct)
                : f.shortPercentOfFloat > 0.08  ? chalk.yellow(pct)
                : chalk.green(pct);
    lines.push(`  Short % of Float:   ${level}${trend}`);
  }
  if (f.sharesShort !== null)  lines.push(`  Shares Short:       ${fmtBig(f.sharesShort).replace('$', '')}`);
  if (f.shortRatio  !== null)  lines.push(`  Days to Cover:      ${f.shortRatio.toFixed(1)} days`);
  lines.push('');
  return lines;
}

function formatOwnership(f: AnalysisResult['financials']): string[] {
  if (f.institutionsPercentHeld === null && f.insidersPercentHeld === null) return [];
  const lines: string[] = [chalk.bold('## 🏛️  Ownership'), ''];
  if (f.institutionsPercentHeld !== null) {
    const count = f.institutionsCount ? `  (${f.institutionsCount.toLocaleString()} holders)` : '';
    lines.push(`  Institutional:   ${(f.institutionsPercentHeld * 100).toFixed(1)}%${count}`);
  }
  if (f.insidersPercentHeld !== null) {
    lines.push(`  Insiders:        ${(f.insidersPercentHeld * 100).toFixed(1)}%`);
  }
  lines.push('');
  return lines;
}

function formatInsiderActivity(f: AnalysisResult['financials']): string[] {
  const hasBuys  = f.insiderBuyCount  !== null && f.insiderBuyCount  > 0;
  const hasSells = f.insiderSellCount !== null && f.insiderSellCount > 0;
  if (!hasBuys && !hasSells) return [];

  const lines: string[] = [chalk.bold('## 👔 Insider Activity  (last 6 months)'), ''];
  lines.push(`| Direction | Transactions | Shares         | Value          |`);
  lines.push(`|-----------|-------------|----------------|----------------|`);

  if (hasBuys) {
    lines.push(`| ${chalk.green('Buy')}       | ${String(f.insiderBuyCount).padEnd(11)} | +${fmtBig(f.insiderBuyShares).replace('$','').padEnd(13)} | +${fmtBig(f.insiderBuyValue).padEnd(14)} |`);
  }
  if (hasSells) {
    lines.push(`| ${chalk.red('Sell')}      | ${String(f.insiderSellCount).padEnd(11)} | -${fmtBig(f.insiderSellShares).replace('$','').padEnd(13)} | -${fmtBig(f.insiderSellValue).padEnd(14)} |`);
  }
  if (hasBuys && hasSells) {
    const netShares = (f.insiderBuyShares ?? 0) - (f.insiderSellShares ?? 0);
    const netValue  = (f.insiderBuyValue  ?? 0) - (f.insiderSellValue  ?? 0);
    const sign = netShares >= 0 ? '+' : '-';
    const col  = netShares >= 0 ? chalk.green : chalk.red;
    lines.push(`| Net       | ${''.padEnd(11)} | ${col(sign + fmtBig(Math.abs(netShares)).replace('$','').padEnd(13))} | ${col(sign + fmtBig(Math.abs(netValue)).padEnd(14))} |`);
  }
  lines.push('');
  return lines;
}

function formatBeneishProbability(p: BeneishResult['probability']): string {
  if (p === 'likely manipulator')   return chalk.red.bold('⚠  likely manipulator  (M > −1.78)');
  if (p === 'grey zone')            return chalk.yellow('~  grey zone  (−2.22 < M < −1.78)');
  if (p === 'unlikely manipulator') return chalk.green('✓  unlikely manipulator  (M < −2.22)');
  return 'unknown';
}

function fvRow(
  label: string,
  fv: number | null | undefined,
  price: number,
  note?: string,
): string {
  if (fv === null || fv === undefined) {
    const placeholder = note ?? 'N/A';
    return `| ${label.padEnd(23)} | ${placeholder.padEnd(19)} | ${''.padEnd(20)} |`;
  }
  const mosPct = ((fv - price) / price * 100).toFixed(1);
  const arrow  = fv > price ? chalk.green(`▲ ${mosPct}%`) : chalk.red(`▼ ${Math.abs(Number(mosPct))}%`);
  return `| ${label.padEnd(23)} | $${fv.toFixed(2).padEnd(18)} | ${arrow} |`;
}

function formatPiotroski(
  sig: PiotroskiSignals,
  score: number,
  maxScore: number,
  bar: string,
  interpretation: string,
): string[] {
  const signal = (v: boolean | null, label: string) =>
    `    ${v === null ? '?' : v ? chalk.green('✓') : chalk.red('✗')}  ${label}`;

  const color = interpretation === 'strong' ? chalk.green : interpretation === 'weak' ? chalk.red : chalk.yellow;

  return [
    `  Score: ${color(`${score}/${maxScore}`)}  [${bar}]  ${color(interpretation.toUpperCase())}`,
    `  Profitability:`,
    signal(sig.f1_positiveROA,            'F1  Positive ROA'),
    signal(sig.f2_positiveCFO,            'F2  Positive Operating Cash Flow'),
    signal(sig.f3_improvingROA,           'F3  Improving ROA YoY'),
    signal(sig.f4_accruals,               'F4  Cash Flow > Accrual Earnings (quality)'),
    `  Leverage / Liquidity:`,
    signal(sig.f5_reducingLeverage,       'F5  Reducing Long-term Leverage'),
    signal(sig.f6_improvingLiquidity,     'F6  Improving Current Ratio'),
    signal(sig.f7_noNewShares,            'F7  No New Share Dilution'),
    `  Efficiency:`,
    signal(sig.f8_improvingGrossMargin,   'F8  Improving Gross Margin'),
    signal(sig.f9_improvingAssetTurnover, 'F9  Improving Asset Turnover'),
  ];
}
