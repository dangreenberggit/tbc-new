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
  /**
   * The first player's own spell damage summed over the run (ticket 831).
   * A spell-hit budget prices hit by it; a caster ranked on a runner that
   * leaves it out fails at the budget.
   */
  spellDamageBySchool?: SpellDamageBySchool;
};

/**
 * Damage keyed by the sim's `SpellSchool` bit (`sim/core/flags.go:226-232`),
 * the value `ActionMetrics.spell_school` carries.
 */
export type SpellDamageBySchool = Readonly<Record<number, number>>;

/**
 * A sim result's first player's damage by school, from its action metrics,
 * melee actions left out (ticket 831). Pets are separate units, so a caller
 * that passes the player's own actions leaves them out too.
 */
export function spellDamageBySchool(
  actions: readonly {
    isMelee: boolean;
    spellSchool: number;
    targets: readonly { damage: number }[];
  }[]
): SpellDamageBySchool {
  const out: Record<number, number> = {};
  for (const action of actions) {
    if (action.isMelee) continue;
    const damage = action.targets.reduce((sum, t) => sum + t.damage, 0);
    if (damage > 0) {
      out[action.spellSchool] = (out[action.spellSchool] ?? 0) + damage;
    }
  }
  return out;
}

export interface SimRunner {
  version(): Promise<string>;
  run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation>;
  /**
   * The stats read (ticket 535): the first player's final stats for the
   * request's gear, with no sim. Meta repair reads hit with it, so hit
   * counts only up to the cap. Required (ticket 830): a runner without it
   * would repair a hit-budget spec at full weight and say nothing.
   */
  computeStats(req: RaidSimRequest): Promise<PlayerStatsObservation>;
  /**
   * Optional (ticket 644): the set bonuses the sim counts active for the
   * request's first player, in the sim's own form `<set name> (<n>pc)`
   * (`GetActiveSetBonusNames`, sim/core/item_sets.go). The ranking reads from
   * it which piece counts a set has a bonus at. When a runner lacks it, the
   * ranking tries every count the pool can fill.
   */
  activeSetBonuses?(req: RaidSimRequest): Promise<readonly string[]>;
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

  /** Recordings hold sims only, so a hit-budget spec's read fails its run. */
  async computeStats(): Promise<PlayerStatsObservation> {
    throw new Error("RecordedSimRunner has no recorded stats reads");
  }
}
