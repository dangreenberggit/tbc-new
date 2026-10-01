/**
 * SimRunner seam — drive the browser's own WASM sim, or replay fixtures.
 *
 * ADAPTED from packages/core/src/seams/sim-runner.ts per decision D4: no
 * `node:crypto` in the fork (the browser has no such module, and plan D4
 * says the cache key only needs uniqueness, not a compression digest). The
 * cache key is the canonical-JSON string itself rather than its sha256 hash
 * — a `Map` key does not need to be short, only stable and collision-free
 * for the same logical request, and `JSON.stringify` over sorted keys gives
 * that directly.
 *
 * `RaidSimRequest` is left as `Readonly<Record<string, unknown>>` rather
 * than the fork's typed proto interface of the same name (`ui/core/proto/
 * api.ts`) — the ported `compose()` (compose.ts) still emits plain protojson
 * objects, matching how packages/core's CLI and this fork's own
 * `WorkerPoolSimRunner` (slice 3) exchange requests with `wasmSimRequest`/
 * `sim_worker.ts`. Slice 3's adapter is what bridges to the fork's real
 * typed `RaidSimRequest` before handing off to `WorkerPool`.
 */

export type RaidSimRequest = Readonly<Record<string, unknown>>;

export type SimRunOpts = {
  seed: number;
  iterations: number;
  /**
   * Ask for each iteration's DPS (ticket 511, the set screen's record mode).
   * Only the screen sets it; a runner that does not support it ignores it.
   * Absent leaves every request and observation exactly as before.
   */
  saveAllValues?: boolean;
};

export type SimObservation = {
  dps: number;
  stdev: number;
  iterationsDone: number;
  simVersion: string;
  /** Each iteration's DPS, only when the run asked with `saveAllValues`. */
  allValues?: readonly number[];
};

/**
 * One candidate in a bulk screening batch. `index` is the caller's own
 * numbering and is what comes back on the matching row, so a runner may
 * reorder freely (the WASM tournament sorts its rows by descending DPS).
 */
export type BulkScreenCandidate = {
  index: number;
  gear: Readonly<Record<string, unknown>>;
};

export type BulkScreenRequest = {
  baseRequest: RaidSimRequest;
  candidates: readonly BulkScreenCandidate[];
  iterations: number;
  /**
   * The seed the batch is simulated at, carried explicitly rather than left to
   * the request builder's own constant. The caller already chooses a seed for
   * the per-candidate path (`SimRunOpts.seed`), and the screening pass must run
   * at the same one — a builder-side default is only correct for as long as it
   * happens to equal the caller's first seed.
   */
  seed: number;
  /**
   * The caller's Stop (ticket 347). A runner that observes it aborts the
   * in-flight chunk and issues no further chunk, then rejects with
   * `BulkScreenAbortedError`. Optional so a runner without cancel support — and
   * every recorded fixture — stays valid.
   */
  signal?: AbortSignal;
};

/**
 * `baseline` is its own field, never an n+1th row — both transports keep the
 * two separate, and screening deltas are taken against it.
 */
export type BulkScreenResult = {
  baseline: SimObservation;
  rows: ReadonlyArray<{ index: number; observation: SimObservation }>;
  /**
   * Chunks whose request failed for an engine-reported or transport reason
   * (ticket 347's rider). Their candidates have no row, and the caller sims
   * them itself through the per-candidate loop. Absent when nothing failed, so
   * a clean run's result type is unchanged.
   */
  failures?: ReadonlyArray<{ indices: readonly number[]; reason: string }>;
};

/**
 * The caller's `signal` fired: the in-flight chunk was aborted and no further
 * chunk was issued. Distinct from every other failure because the caller asked
 * for it — `rank.ts` treats it as an abort observed before the pass, not an
 * error.
 */
export class BulkScreenAbortedError extends Error {
  override readonly name = "BulkScreenAbortedError";

  constructor() {
    super("bulk screen aborted by the caller's signal");
  }
}

/**
 * A bulk response that is structurally wrong — a row shortfall, or no baseline.
 * These are the checks that stand between a silent cull and a truncated
 * ranking, so they must never degrade to the per-candidate loop the way an
 * engine-reported or transport failure does; the driver rethrows this class
 * unconditionally.
 *
 * It lives in the seam rather than beside the check that throws it because
 * `rank.ts` names it, and the engine may not import from `adapters/`.
 */
export class BulkScreenIntegrityError extends Error {
  override readonly name = "BulkScreenIntegrityError";

  constructor(message: string) {
    super(message);
  }
}

export interface SimRunner {
  version(): Promise<string>;
  run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation>;
  /**
   * Optional bulk screening capability. When a runner offers it, the ranking's
   * screening pass hands it whole batches instead of looping `run` per
   * candidate; when it is absent the loop runs unchanged, so this is additive
   * and every existing runner stays valid. Stated in protojson vocabulary for
   * the same reason `RaidSimRequest` is (see this file's header): the engine
   * stays proto-unaware, and the adapter bridges to typed protos.
   */
  runBulkScreen?(req: BulkScreenRequest): Promise<BulkScreenResult>;
}

/**
 * Stable key: canonical-JSON(request) + version + seed + iterations (D4). A run
 * that asks for per-iteration values gets its own `:all` key, so a stored
 * observation without them never answers it; no other key changes.
 */
export function simCacheKey(
  req: RaidSimRequest,
  simVersion: string,
  opts: SimRunOpts
): string {
  const key = `${stableStringify(req)}:${simVersion}:${opts.seed}:${opts.iterations}`;
  return opts.saveAllValues === true ? `${key}:all` : key;
}

/**
 * Stable key for a whole screening batch, same scheme as `simCacheKey` (D4):
 * canonical JSON, no digest. The candidate list is part of the key because a
 * different batch is a different question, and so are the seed and iteration
 * count — the same batch simulated at a different seed is a different
 * measurement, and omitting the seed would let two of them collide on one
 * recording. Note the key is transport-blind by its fields only; `simVersion` is
 * supplied by whichever runner recorded it.
 */
export function bulkScreenCacheKey(
  req: BulkScreenRequest,
  simVersion: string
): string {
  return `bulk:${stableStringify(req.baseRequest)}:${stableStringify(
    req.candidates
  )}:${simVersion}:${req.seed}:${req.iterations}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export class RecordedSimRunner implements SimRunner {
  constructor(
    private readonly simVersion: string,
    private readonly recordings: ReadonlyMap<string, SimObservation>,
    /**
     * Absent means this runner offers no bulk capability, so a test built from
     * it exercises the per-candidate loop — which is what every existing
     * fixture wants. Supplying it opts a fixture into the bulk branch.
     */
    private readonly bulkRecordings?: ReadonlyMap<string, BulkScreenResult>
  ) {
    // An own property, not a prototype method: `rank.ts` treats
    // `deps.sim.runBulkScreen` as a truthy capability check, so a recorded
    // runner given no bulk fixtures must not appear to have the capability at
    // all. A prototype method could not be hidden this way — `delete` does not
    // remove inherited members.
    if (bulkRecordings !== undefined) {
      this.runBulkScreen = async (req: BulkScreenRequest) => {
        const key = bulkScreenCacheKey(req, this.simVersion);
        const hit = bulkRecordings.get(key);
        if (!hit) {
          throw new Error(`no recording for bulk screen key ${key}`);
        }
        return hit;
      };
    }
  }

  runBulkScreen?: (req: BulkScreenRequest) => Promise<BulkScreenResult>;

  async version(): Promise<string> {
    return this.simVersion;
  }

  async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
    const key = simCacheKey(req, this.simVersion, opts);
    const hit = this.recordings.get(key);
    if (!hit) {
      throw new Error(`no recording for sim key ${key}`);
    }
    return hit;
  }
}
