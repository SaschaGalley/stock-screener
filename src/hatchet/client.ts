/**
 * The Hatchet connection, created lazily and exactly once.
 *
 * Lazy because Hatchet is optional: the CLI, the API server and the nightly
 * scheduler all have to keep working on a machine that has never heard of it.
 * Importing this module therefore costs nothing — the client is built on the
 * first `getHatchet()`, and a missing token surfaces as an actionable error at
 * that point rather than as a crash at boot.
 *
 * Imported from the package root rather than the `/v1` subpath the SDK's own
 * warnings point at: it ships as CommonJS with no `exports` map, so TypeScript
 * cannot resolve subpaths under NodeNext. The root re-exports the same v1
 * `HatchetClient`, at the cost of a one-off v0 deprecation notice on import.
 */

import { HatchetClient } from '@hatchet-dev/typescript-sdk';

import { getConfig } from '../config.js';

/** Thrown when something asks for Hatchet on an installation without a token. */
export class HatchetNotConfiguredError extends Error {
  constructor() {
    super(
      'Hatchet is not configured. Set HATCHET_CLIENT_TOKEN in .env — mint one in '
      + 'the Hatchet UI under Settings → API Tokens. For a self-hosted server '
      + 'that does not terminate TLS, add HATCHET_CLIENT_TLS_STRATEGY=none.',
    );
    this.name = 'HatchetNotConfiguredError';
  }
}

let client: HatchetClient | null = null;

/**
 * Whether this installation has Hatchet credentials at all. Callers use it to
 * degrade gracefully — an absent queue is a supported configuration, not a
 * fault.
 */
export function isHatchetConfigured(): boolean {
  return Boolean(getConfig().hatchetToken);
}

/**
 * The shared client. Throws `HatchetNotConfiguredError` when no token is set,
 * so the caller can decide between skipping the work and failing loudly.
 */
export function getHatchet(): HatchetClient {
  if (client) return client;
  if (!isHatchetConfigured()) throw new HatchetNotConfiguredError();

  // No arguments: the SDK resolves token, host, namespace and TLS strategy
  // from HATCHET_CLIENT_* itself, which keeps those settings in one place.
  client = HatchetClient.init();
  return client;
}
