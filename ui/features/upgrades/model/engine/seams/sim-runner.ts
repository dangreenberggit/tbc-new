/**
 * SimRunner: runs the browser's own WASM sim, or replays recorded results.
 *
 * `RaidSimRequest` is plain protojson, as `compose()` emits, not the typed proto of the
 * same name; `WorkerPoolSimRunner` (model/adapters/worker_pool_sim_runner.ts) converts
 * it before handing off to `WorkerPool`.
 */

export type RaidSimRequest = Readonly<Record<string, unknown>>;

export type SimRunOpts = {
	seed: number;
	iterations: number;
	/** Ask for each iteration's DPS (set screen `'record'` mode); a runner may ignore it. */
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
	 * The first player's own spell damage over the run. A spell hit budget weighs hit by
	 * it, so a caster ranked on a runner that leaves it out fails at the budget.
	 */
	spellDamageBySchool?: SpellDamageBySchool;
};

/**
 * Damage keyed by the sim's `SpellSchool` bit (sim/core/flags.go), the value
 * `ActionMetrics.spell_school` carries.
 */
export type SpellDamageBySchool = Readonly<Record<number, number>>;

/**
 * The first player's damage by school from its action metrics, melee left out. Pets are
 * separate units, so passing the player's own actions leaves them out too.
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
	 * The first player's final stats for the request's gear, with no sim. Meta repair
	 * reads hit with it so hit counts only up to the cap. Required: a runner without it
	 * would price hit at full weight for a spec with a hit budget, and say nothing.
	 */
	computeStats(req: RaidSimRequest): Promise<PlayerStatsObservation>;
	/**
	 * The first player's active set bonuses as `<set name> (<n>pc)`
	 * (`GetActiveSetBonusNames`, sim/core/item_sets.go), which tell the ranking which
	 * counts a set has a bonus at. Without it the ranking tries every count the pool fills.
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
 * The request as sorted-key JSON, plus version, seed and iterations, kept as a string
 * rather than a hash since a `Map` key need only be stable and unique. A `saveAllValues`
 * run gets its own `:all` key, so a stored observation without the values never answers it.
 */
export function simCacheKey(req: RaidSimRequest, simVersion: string, opts: SimRunOpts): string {
	const key = `${stableStringify(req)}:${simVersion}:${opts.seed}:${opts.iterations}`;
	return opts.saveAllValues === true ? `${key}:all` : key;
}

/**
 * JSON with object keys sorted, so equal requests give one string. rank.ts also keys its
 * stats reads by it.
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

	/** Recordings hold sim results only, so a spec with a hit budget fails here. */
	async computeStats(): Promise<PlayerStatsObservation> {
		throw new Error('RecordedSimRunner has no recorded stats reads');
	}
}
