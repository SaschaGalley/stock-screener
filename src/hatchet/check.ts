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
 *
 * Two traps this walked into, hence the extra steps:
 *
 *   - "Something answered" is not "Hatchet answered". Pointed at an unrelated
 *     dev server on localhost:8080, the worker listing came back as a cheerful
 *     empty list. The meta endpoint is checked to confirm what is on the line.
 *   - REST reachable does not imply gRPC reachable. A reverse proxy that
 *     serves the dashboard happily can still refuse to route gRPC, and only
 *     the round trip goes over gRPC — so a run without a worker must not
 *     claim the connection is good.
 */

import { connect } from 'net';

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

/**
 * The REST base the SDK will actually use: an explicit override wins, else the
 * address baked into the token.
 */
function effectiveApiUrl(claims: Record<string, unknown>): string | null {
  return process.env.HATCHET_CLIENT_API_URL ?? (claims.server_url as string | undefined) ?? null;
}

/**
 * Confirm the thing on the other end is Hatchet and not merely something that
 * returns 200. `/api/v1/meta` is unauthenticated and shaped distinctively.
 */
async function isHatchetServer(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/v1/meta', apiUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const body = await res.json() as Record<string, unknown>;
    return 'auth' in body && 'allowSignup' in body;
  } catch {
    return false;
  }
}

/**
 * The gRPC endpoint the SDK will dial: an explicit override wins, else the
 * address the token carries.
 */
function effectiveGrpcTarget(claims: Record<string, unknown>): { host: string; port: number } | null {
  const raw = process.env.HATCHET_CLIENT_HOST_PORT
    ?? (claims.grpc_broadcast_address as string | undefined);
  if (!raw) return null;
  const at = raw.lastIndexOf(':');
  if (at < 1) return null;
  const port = Number(raw.slice(at + 1));
  return Number.isFinite(port) ? { host: raw.slice(0, at), port } : null;
}

/**
 * Can a TCP socket be opened to the gRPC port at all?
 *
 * Deliberately below the SDK. gRPC failures surface as a generic UNAVAILABLE
 * that reads the same whether the port is closed, the name does not resolve or
 * a proxy answered with plain HTTP — and those have nothing in common as
 * fixes. A raw socket separates "nothing is listening" from everything else.
 */
function probeTcp(host: string, port: number, ms = 6_000): Promise<'open' | 'refused' | 'dns' | 'timeout'> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r: 'open' | 'refused' | 'dns' | 'timeout') => {
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done('timeout'), ms);
    socket.on('connect', () => done('open'));
    socket.on('error', (e: NodeJS.ErrnoException) =>
      done(e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'dns' : 'refused'));
  });
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
    ['API override',  'HATCHET_CLIENT_API_URL'],
    ['host override', 'HATCHET_CLIENT_HOST_PORT'],
    ['TLS strategy',  'HATCHET_CLIENT_TLS_STRATEGY'],
    ['namespace',     'HATCHET_CLIENT_NAMESPACE'],
  ] as const) {
    if (process.env[key]) note(`${label}: ${process.env[key]} (${key})`);
  }

  // A server deployed without its public URLs configured mints tokens that
  // point at its own loopback. Harmless on the server, useless anywhere else,
  // and the symptom is otherwise a baffling connection error.
  const embedded = `${claims.grpc_broadcast_address ?? ''} ${claims.server_url ?? ''}`;
  if (/localhost|127\.0\.0\.1/.test(embedded)) {
    console.log('');
    warn('The token points at localhost — the server does not know its own public address.');
    note('Fine if Hatchet runs on this machine. Otherwise override both:');
    note('  HATCHET_CLIENT_API_URL=https://hatchet.example.com');
    note('  HATCHET_CLIENT_HOST_PORT=hatchet.example.com:443');
    note('The lasting fix is SERVER_URL and GRPC_BROADCAST_ADDRESS on the server.');
  }

  // A diagnostic should report a failure, not sit in a retry loop printing it.
  // Set before the client is constructed, since it reads these at init.
  process.env.HATCHET_CLIENT_RETRIER_MAX_ATTEMPTS ??= '1';
  process.env.HATCHET_CLIENT_LOG_LEVEL ??= 'OFF';

  // Imported here rather than at the top: constructing the client needs the
  // token we only just proved is present.
  const { getHatchet } = await import('./client.js');
  const hatchet = getHatchet();

  // ── 2. Reachability (REST) ─────────────────────────────────────────────────
  console.log('');
  const apiUrl = effectiveApiUrl(claims);
  if (!apiUrl) {
    bad('No REST address: none in the token and no HATCHET_CLIENT_API_URL set.');
    process.exitCode = 1;
    return;
  }
  if (!await isHatchetServer(apiUrl)) {
    bad(`Nothing that looks like Hatchet is answering at ${apiUrl}`);
    note('Its /api/v1/meta did not respond the way Hatchet does — wrong address,');
    note('or something else is occupying that port. Set HATCHET_CLIENT_API_URL.');
    process.exitCode = 1;
    return;
  }
  ok(`Hatchet confirmed at ${apiUrl}`);

  // ── 3. Reachability (gRPC) ─────────────────────────────────────────────────
  // Checked separately because it is a different port, and on a proxied
  // deployment usually a different route: the dashboard can be perfectly
  // healthy while nothing forwards gRPC at all.
  const grpc = effectiveGrpcTarget(claims);
  if (!grpc) {
    warn('No gRPC address in the token and no HATCHET_CLIENT_HOST_PORT set.');
  } else {
    const reach = await probeTcp(grpc.host, grpc.port);
    const where = `${grpc.host}:${grpc.port}`;
    if (reach === 'open') {
      ok(`gRPC port reachable at ${where}`);
    } else {
      bad(`gRPC port not reachable at ${where} (${reach})`);
      if (reach === 'dns') {
        note('That name does not resolve from here.');
      } else {
        note('Nothing is listening there. On a container deployment the engine');
        note('binds 7077 inside the container — the port still has to be');
        note('published to the host, which a broadcast-address setting does not do.');
        note('Publish it on a private interface rather than 0.0.0.0, e.g.');
        note('  <tailscale-ip>:7077:7077');
      }
      note('Until this opens, no task can be queued or run.');
      process.exitCode = 1;
      return;
    }
  }

  let workers;
  try {
    workers = (await hatchet.workers.list()).rows ?? [];
    ok('The REST API accepted the token.');
  } catch (e) {
    const msg = (e as Error).message;
    bad(`Could not reach Hatchet: ${msg}`);
    explain(msg);
    process.exitCode = 1;
    return;
  }

  // ── 4. Is anything listening? ──────────────────────────────────────────────
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
    warn('REST works, but nothing is available to run tasks.');
    note('Start one in another terminal: pnpm hatchet:worker');
    // Said plainly because the two travel over different ports and a proxy
    // that serves the dashboard can still refuse to route gRPC.
    note('Note that this has only proved REST. Tasks travel over gRPC, which');
    note('is a separate route — the round trip below is what proves it.');
    process.exitCode = 1;
    return;
  }

  // ── 5. Round trip ──────────────────────────────────────────────────────────
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
