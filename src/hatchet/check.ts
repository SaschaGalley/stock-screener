/**
 * `pnpm hatchet:check` — does this machine actually reach Hatchet?
 *
 * Written to separate the failure modes, because they have different fixes and
 * a single "it does not work" sends you looking in the wrong place:
 *
 *   no token           → mint one in the UI
 *   token unreadable   → wrong value pasted
 *   connection refused → wrong host, or TLS strategy mismatched to the server
 *   no worker          → connection is fine, nothing is listening
 *
 * The order matters. Reachability is proved over the REST API first, which
 * fails fast and cheaply; only then is a task enqueued. Doing it the other way
 * round — enqueue and wait — cannot tell "queued but unattended" from "never
 * connected", because both present as silence.
 */

import chalk from 'chalk';

import { getConfig } from '../config.js';
import { isHatchetConfigured } from './client.js';

/** How long to wait for a worker to pick the ping up, once we know one exists. */
const WAIT_MS = 20_000;

const ok   = (m: string) => console.log(`${chalk.green('✓')} ${m}`);
const bad  = (m: string) => console.log(`${chalk.red('✗')} ${m}`);
const warn = (m: string) => console.log(`${chalk.yellow('!')} ${m}`);
const note = (m: string) => console.log(`  ${chalk.dim(m)}`);

/**
 * The claims inside a Hatchet API token, without verifying it.
 *
 * Worth showing: the token carries the server's own idea of its address, so it
 * usually answers "do I also need HATCHET_CLIENT_HOST_PORT?" — normally no. We
 * only read it to report; the SDK does the real thing with it.
 */
function describeToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Turn a gRPC/HTTP failure into the thing to go and change. */
function explain(msg: string): void {
  if (/UNAVAILABLE|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|DEADLINE|ETIMEDOUT/i.test(msg)) {
    note('Reads like a network or TLS problem rather than a credential one:');
    note('  · is the address above reachable from this machine?');
    note('  · plain-HTTP server? set HATCHET_CLIENT_TLS_STRATEGY=none');
    note('  · address wrong inside the token? override HATCHET_CLIENT_HOST_PORT');
  } else if (/UNAUTHENTICATED|PERMISSION|401|403/i.test(msg)) {
    note('Reads like the token was rejected — mint a fresh one for this tenant.');
  }
}

async function main(): Promise<void> {
  console.log(chalk.bold('\nHatchet connectivity check\n'));

  // ── 1. Configuration ───────────────────────────────────────────────────────
  if (!isHatchetConfigured()) {
    bad('HATCHET_CLIENT_TOKEN is not set.');
    note('Hatchet UI → Settings → API Tokens → create one, then put it in .env');
    process.exitCode = 1;
    return;
  }
  const token = getConfig().hatchetToken!;
  ok(`HATCHET_CLIENT_TOKEN is set (${token.length} chars)`);

  const claims = describeToken(token);
  if (!claims) {
    bad('The token is not a readable JWT — it looks truncated or mis-pasted.');
    process.exitCode = 1;
    return;
  }
  note(`server from token: ${claims.grpc_broadcast_address ?? claims.server_url ?? '(not in token)'}`);
  if (claims.aud) note(`tenant/audience:   ${String(claims.aud)}`);

  for (const [label, key] of [
    ['host override', 'HATCHET_CLIENT_HOST_PORT'],
    ['TLS strategy',  'HATCHET_CLIENT_TLS_STRATEGY'],
    ['namespace',     'HATCHET_CLIENT_NAMESPACE'],
  ] as const) {
    if (process.env[key]) note(`${label}: ${process.env[key]} (${key})`);
  }

  // A diagnostic should report a failure, not sit in a retry loop printing it.
  // Set before the client is constructed, since it reads these at init.
  process.env.HATCHET_CLIENT_RETRIER_MAX_ATTEMPTS ??= '1';
  process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'OFF';

  // Imported here rather than at the top: constructing the client needs the
  // token we only just proved is present.
  const { getHatchet } = await import('./client.js');
  const hatchet = getHatchet();

  // ── 2. Reachability ────────────────────────────────────────────────────────
  console.log('');
  let workers;
  try {
    workers = (await hatchet.workers.list()).rows ?? [];
    ok('Reached the Hatchet API and the token was accepted.');
  } catch (e) {
    const msg = (e as Error).message;
    bad(`Could not reach Hatchet: ${msg}`);
    explain(msg);
    process.exitCode = 1;
    return;
  }

  // ── 3. Is anything listening? ──────────────────────────────────────────────
  const active = workers.filter((w) => w.status === 'ACTIVE');
  if (workers.length === 0) {
    warn('No workers are registered with this tenant.');
  } else {
    for (const w of workers) {
      const label = `${w.name} · ${w.status ?? 'unknown'}`;
      if (w.status === 'ACTIVE') ok(`worker: ${label}`);
      else note(`worker: ${label}`);
    }
  }

  if (active.length === 0) {
    warn('The connection works, but nothing is available to run tasks.');
    note('Start one in another terminal: pnpm hatchet:worker');
    note('Then run this check again to complete the round trip.');
    process.exitCode = 1;
    return;
  }

  // ── 4. Round trip ──────────────────────────────────────────────────────────
  console.log(chalk.bold('\nEnqueuing a ping…\n'));
  const sentAt = Date.now();
  const { ping } = await import('./tasks/ping.js');

  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      ping.run({ message: `check from ${process.env.USER ?? 'unknown'}` }),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), WAIT_MS); }),
    ]);

    if (result === 'timeout') {
      bad(`A worker is registered, but the ping did not finish within ${WAIT_MS / 1000}s.`);
      note('Is the worker on a different HATCHET_CLIENT_NAMESPACE than this check?');
      process.exitCode = 1;
      return;
    }

    ok(`Round trip in ${Date.now() - sentAt}ms`);
    note(`ran on: ${result.workerHost} (node ${result.nodeVersion})`);
    note(`echoed: ${result.message}`);
    console.log(chalk.green.bold('\nHatchet is reachable and a worker is serving tasks.\n'));
  } catch (e) {
    const msg = (e as Error).message;
    bad(`The ping failed: ${msg}`);
    explain(msg);
    process.exitCode = 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(chalk.red(`\nUnexpected failure: ${(e as Error).message}\n`));
    process.exit(1);
  });
