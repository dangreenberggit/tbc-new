/**
 * Batch partitioning for the bulk screening pass.
 *
 * Shared by both transports: the WASM runner posts each chunk to the in-browser
 * tournament, the Go runner posts the same chunks over HTTP. One constant and
 * one function, so the two engines cannot drift apart on batch size.
 *
 * Not ported from `packages/core` — it has no ancestor there, so it carries no
 * `PROVENANCE.md` row (`tools/README.md:11`; the drift checker is table-driven
 * over that file's rows, so an absent file is never hashed).
 */

import type { BulkScreenCandidate } from "../seams/sim-runner.js";

/**
 * The largest batch either engine screens without culling anything.
 *
 * Both engines run a single High-only stage below a threshold and only then
 * start culling, and the shared constant has to sit inside BOTH regimes:
 *
 * - Go engages its Medium stage at 26 candidates.
 * - The TS tournament stays High-only up to 32 at 5,000 iterations. That bound
 *   is iteration-sensitive and moves *down* as iterations rise (it is 39 at
 *   3,000), because `shouldUseLegacyBulkSim` compares an estimate of the
 *   pre-High stages against `highStageIterations * candidateCount`
 *   (`wasm/bulk_sim/estimate.ts:14-32`).
 *
 * The 32 is measured, not only derived: an n=32 batch returns one row per
 * candidate from a single stage with every candidate surviving, while n=33 runs
 * two stages and comes back with 5 rows of 33 — silently, with no error field
 * set, which is why the runner also asserts row completeness per chunk.
 *
 * 25 is the largest value inside both, so it is the shared constant. The web
 * side could carry 32; that headroom is deliberately left on the table rather
 * than letting the two transports use different batch sizes.
 *
 * Culling is what this bound prevents. It does NOT guarantee a row per
 * candidate on its own — `wasm/bulk_sim/statistics.ts:107` drops any result
 * lacking `dpsMetrics` before slicing — so the runner asserts row completeness
 * per chunk as well.
 */
export const MAX_CANDIDATES_PER_BULK_REQUEST = 25;

/**
 * Splits candidates into chunks no larger than `maxPerRequest`, preserving
 * order and every candidate's own `index`. Chunking is the only mechanism that
 * keeps a batch inside the no-culling regime, so an oversized slot is split
 * rather than trimmed: no candidate is ever dropped.
 */
export function partitionForBulkScreen(
  candidates: readonly BulkScreenCandidate[],
  maxPerRequest: number = MAX_CANDIDATES_PER_BULK_REQUEST
): BulkScreenCandidate[][] {
  if (!Number.isInteger(maxPerRequest) || maxPerRequest < 1) {
    throw new Error(
      `partitionForBulkScreen: maxPerRequest must be a positive integer, got ${maxPerRequest}`
    );
  }
  const chunks: BulkScreenCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += maxPerRequest) {
    chunks.push(candidates.slice(i, i + maxPerRequest));
  }
  return chunks;
}
