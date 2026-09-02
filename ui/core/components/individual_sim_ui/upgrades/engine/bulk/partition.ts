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
 * start culling, and the shared constant has to sit inside BOTH regimes.
 *
 * On both engines the gate that decides whether the earlier stages run at all
 * is `shouldUseLegacyBulkSim`, which compares an estimate of the pre-High stages
 * against `highStageIterations * candidateCount` (`wasm/bulk_sim/estimate.ts:
 * 14-32`; `sim/core/bulk/estimate.go` on the Go side). It is NOT the Medium
 * stage's own survivor limit (`MaxSurvivors: 25` in `stage.go`) — that limit is
 * real but only applies once the estimator has already decided to run more than
 * one stage, so it does not set the no-culling boundary.
 *
 * Measured at 5,000 iterations, both engines flip between 32 and 33: n = 26, 30
 * and 32 each come back single-stage with one row per candidate, while n = 33
 * runs two stages and returns 5 rows of 33 — silently, with no error field set,
 * which is why the runners also assert row completeness per chunk. The two
 * boundaries being identical is measured on both engines, not assumed from one.
 *
 * The boundary moves *down* as iterations rise, but it floors. Running
 * upstream's estimator over twelve iteration counts gives the first multi-stage
 * n as:
 *
 *     3,000 → 40   10,000 → 30   28,001 → 27
 *     5,000 → 33   15,000 → 28   30,000 → 27
 *     7,500 → 31   20,000 → 28   50,000 → 27
 *                  28,000 → 28   100,000 → 27   1,000,000 → 27
 *
 * so n = 25 and n = 26 are single-stage at every one of them. Two mechanisms,
 * both identical on the Go side. At n ≤ 25 no pre-High stage runs at all —
 * Medium needs `candidateCount > maxSurvivors` (25) and Low needs > 100
 * (`stage.ts:69-76`) — so the estimate reduces to `high×(n+1) ≥ high×n`, true
 * for any `high`. At n = 26 Medium does run, and the comparison becomes
 * `1000×27 + high×26 ≥ high×26`, again true for any `high`. Only at n = 27 does
 * the inequality start to depend on the iteration count, and it flips at 28,001.
 *
 * So 25 is iteration-invariant by construction, not by luck at today's default
 * — the failure ticket 349 feared cannot happen at this constant. What could
 * happen is a future raise to 27 culling silently above 28,000 iterations, so
 * `adapters/bulk_request_builder.ts`'s `assertSingleStageChunk` checks every
 * built request against upstream's estimator and throws rather than letting it
 * pass. The table above is reproduced by
 * `packages/core/test/bulk-boundary.test.ts`.
 *
 * 25 is inside both regimes with margin, so it is the shared constant. Both
 * sides could carry 32 at today's default; that headroom is deliberately left on
 * the table rather than letting the two transports use different batch sizes.
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
