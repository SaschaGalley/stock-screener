import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { marked } from 'marked';
import { symbolDir } from '../cache.js';
import { logger } from '../utils/logger.js';

// ── Chrome discovery ──────────────────────────────────────────────────────────

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

async function findChrome(): Promise<string | null> {
  const { existsSync } = await import('fs');
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── ANSI strip ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ── HTML template ─────────────────────────────────────────────────────────────

function wrapHtml(body: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; line-height: 1.6; color: #1a1a1a;
      max-width: 960px; margin: 0 auto; padding: 32px 24px;
    }
    h1 { font-size: 1.8em; margin-bottom: 4px; }
    h2 { font-size: 1.2em; margin: 28px 0 10px; padding-bottom: 4px;
         border-bottom: 1px solid #e0e0e0; }
    h3 { font-size: 1em; margin: 16px 0 6px; color: #333; }
    p  { margin: 6px 0; }
    ul, ol { margin: 6px 0 6px 20px; }
    li { margin: 2px 0; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f5f5f5; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    pre  { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
    blockquote { border-left: 3px solid #ccc; padding-left: 12px; color: #555; margin: 8px 0; }
    hr { border: none; border-top: 1px solid #e0e0e0; margin: 20px 0; }
    strong { font-weight: 600; }
    .meta { color: #888; font-size: 12px; margin-bottom: 24px; }
    @media print {
      body { max-width: none; padding: 16px; }
      h2 { page-break-after: avoid; }
    }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

// ── PDF via puppeteer-core ────────────────────────────────────────────────────

async function htmlToPdf(html: string, outputPath: string): Promise<void> {
  const chromePath = await findChrome();
  if (!chromePath) {
    logger.warn('PDF skipped — Chrome not found. Install Google Chrome to enable PDF export.');
    return;
  }

  const puppeteer = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    // 'load' instead of 'networkidle0': the HTML is self-contained (inline
    // CSS, no external fonts/images) so there's nothing to network-wait for,
    // and the puppeteer-core typings don't include 'networkidle0' for setContent.
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function saveReports(
  symbol: string,
  cacheDir: string,
  terminalOutput: string,
): Promise<void> {
  const dir      = symbolDir(cacheDir, symbol);
  mkdirSync(dir, { recursive: true });

  const mdPath   = join(dir, 'report.md');
  const htmlPath = join(dir, 'report.html');
  const pdfPath  = join(dir, 'report.pdf');

  const clean = stripAnsi(terminalOutput);

  // Markdown
  writeFileSync(mdPath, clean, 'utf-8');

  // HTML
  const htmlBody = await marked(clean);
  const html = wrapHtml(htmlBody, `${symbol} — Investment Analysis`);
  writeFileSync(htmlPath, html, 'utf-8');

  // PDF
  await htmlToPdf(html, pdfPath);

  logger.success(`Reports saved → ${dir}/report.{md,html,pdf}`);
}
