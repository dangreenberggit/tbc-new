/**
 * SimRunner seam: drive the browser's own WASM sim, or replay fixtures.
 *
 * The cache key is the canonical-JSON string itself rather than a hash: a
 * `Map` key need only be stable and collision-free for the same logical
 * request.
 *
 * `RaidSimRequest` is plain protojson rather than the typed proto interface of
 * the same name (ui/generated/proto/api.ts), because `compose()` (compose.ts)
 * emits protojson objects. `WorkerPoolSimRunner`
 * (ui/features/upgrades/model/adapters/worker_pool_sim_runner.ts) converts to
 * the typed `RaidSimRequest` before handing off to `WorkerPool`.
 */

export type RaidSimRequest = Readonly<Record<string, unknown>>;

export type SimRunOpts = {
	seed: number;
	iterations: number;
	/**
	 * Ask for each iteration's DPS (the set screen's record mode). Only the
	 * screen sets it; a runner that does not support it ignores it.
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
	 * The first player's own spell damage summed over the run.
	 * A spell-hit budget prices hit by it; a caster ranked on a runner that
	 * leaves it out fails at the budget.
	 */
	spellDamageBySchool?: SpellDamageBySchool;
};

/**
 * Damage keyed by the sim's `SpellSchool` bit (sim/core/flags.go),
 * the value `ActionMetrics.spell_school` carries.
 */
export type SpellDamageBySchool = Readonly<Record<number, number>>;

/**
 * A sim result's first player's damage by school, from its action metrics,
 * melee actions left out. Pets are separate units, so a caller
 * that passes the player's own actions leaves them out too.
 */
export function spellDamageBySchool(
	actions: readonly {
		isMelee: boolean;
		spellSchool: number;
		targets: readonly { damage: number }[];
	}[],
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
	 * The stats read: the first player's final stats for the request's gear,
	 * with no sim. Meta repair reads hit with it, so hit counts only up to the
	 * cap. Required: a runner without it
	 * would repair a hit-budget spec at full weight and say nothing.
	 */
	computeStats(req: RaidSimRequest): Promise<PlayerStatsObservation>;
	/**
	 * Optional: the set bonuses the sim counts active for the
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
 * Stable key: canonical-JSON(request) + version + seed + iterations. A run
 * that asks for per-iteration values gets its own `:all` key, so a stored
 * observation without them never answers it; no other key changes.
 */
export function simCacheKey(req: RaidSimRequest, simVersion: string, opts: SimRunOpts): string {
	const key = `${stableStringify(req)}:${simVersion}:${opts.seed}:${opts.iterations}`;
	return opts.saveAllValues === true ? `${key}:all` : key;
}

/**
 * Canonical JSON with object keys sorted, so two equal requests give one
 * string. Exported for the set phase's per-request stats-read cache.
 */
export function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === 'object') {
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
		throw new Error('RecordedSimRunner has no recorded stats reads');
	}
}
