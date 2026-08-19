/**
 * The smallest task that proves the whole loop works.
 *
 * A round trip through Hatchet touches four things that can each be broken
 * independently: the token is valid, the gRPC address is reachable, a worker
 * is connected and listening on the right namespace, and results travel back.
 * `ping` exercises all four and touches nothing else — no database, no third
 * party — so a failure here is unambiguously about the wiring.
 *
 * `retries: 0` on purpose. Everywhere else in this codebase a retry is a
 * feature; here it would only hide the connection problem we are trying to see.
 */

import { hostname } from 'os';

import { getHatchet } from '../client.js';

export type PingInput = {
  /** Echoed back untouched, so the caller can prove it got *its* run back. */
  message: string;
}

export type PingOutput = {
  message:     string;
  /** Host the worker runs on — tells local and server workers apart. */
  workerHost:  string;
  nodeVersion: string;
  /** Set by the worker, not the caller: the clock that actually did the work. */
  ranAt:       string;
}

// Declared as `type` above rather than `interface`: the SDK constrains task
// input to a JSON object, and only a type alias carries the implicit index
// signature that satisfies it.
export const ping = getHatchet().task<PingInput, PingOutput>({
  name:    'ping',
  retries: 0,
  fn: (input): PingOutput => ({
    message:     input.message,
    workerHost:  hostname(),
    nodeVersion: process.version,
    ranAt:       new Date().toISOString(),
  }),
});
