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

export interface SimRunner {
  version(): Promise<string>;
  run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation>;
  /**
   * Optional stats read (ticket 535): the first player's final stats for the
   * request's gear, with no sim. Meta repair reads the baseline's hit with it,
   * and each set-phase version's, so hit counts only up to the cap. When a
   * runner lacks it, repair values hit at full weight, so a runner without it
   * stays valid.
   */
  computeStats?(req: RaidSimRequest): Promise<PlayerStatsObservation>;
}

/**
 * The first player's `finalStats` from a stats read: the dense `stats` and
 * `pseudoStats` arrays, indexed by the proto's `Stat` and `PseudoStat`.
 */
export type PlayerStatsObservation = {
  stats: readonly number[];
  pseudoStats: readonly number[];
};

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
 * Canonical JSON with object keys sorted, so two equal requests give one
 * string. Exported for the set phase's per-request stats-read cache
 * (ticket 535).
 */
export function stableStringify(value: unknown): string {
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
    private readonly recordings: ReadonlyMap<string, SimObservation>
  ) {}

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
