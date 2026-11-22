/**
 * The sim helpers `rankUpgrades` and the set phase share: the store-cached run, the stats
 * read, the runner that refuses new sims after Stop, and the counted delta sims of the
 * bonus-gear and bonus-off sims. Other call sites call `deps.sim` directly. Store faults are
 * `internal`; only the sim's own failure is a failed sim.
 */

import { promisePool } from './promise-pool';
import { type Deps, RankError } from './rank-types';
import { type PlayerStatsObservation, type RaidSimRequest, simCacheKey, type SimObservation, type SimRunOpts } from './seams/sim-runner';
import { errorText, isSimFailure, type SimFailure } from './set-less-copies';
import { type DpsSample, sampleOf } from './set-value';

/** Namespaced so a ranking cannot collide with another stored value. */
export function rankingCacheKey(contentHash: string): string {
	return `ranking:${contentHash}`;
}

export async function readCachedSim(deps: Deps, req: RaidSimRequest, simVersion: string, opts: SimRunOpts): Promise<SimObservation | undefined> {
	return asInternal(() => deps.store.get<SimObservation>(simStoreKey(req, simVersion, opts)));
}

function simStoreKey(req: RaidSimRequest, simVersion: string, opts: SimRunOpts): string {
	return `sim:${simCacheKey(req, simVersion, opts)}`;
}

export async function cacheSimResult(deps: Deps, req: RaidSimRequest, simVersion: string, opts: SimRunOpts, observation: SimObservation): Promise<void> {
	await asInternal(() => deps.store.put(simStoreKey(req, simVersion, opts), observation));
}

/**
 * Read the store, run the sim on a miss, write the store: every store-cached
 * sim of a run. A failed sim comes back as `simError`, the error it threw, so
 * each caller decides what it costs. A failed store read or write still
 * throws, as an `internal` fault.
 */
export async function simOrFailure(
	deps: Deps,
	req: RaidSimRequest,
	simVersion: string,
	opts: SimRunOpts,
): Promise<{ observation: SimObservation; fromStore: boolean } | { simError: unknown }> {
	const cached = await readCachedSim(deps, req, simVersion, opts);
	if (cached) return { observation: cached, fromStore: true };
	// Only `deps.sim.run` belongs inside this catch. A store read or write
	// that fails is an `internal` fault, and labeling it `sim-failed` sends
	// an operator to the wrong subsystem.
	let observation: SimObservation;
	try {
		observation = await deps.sim.run(req, opts);
	} catch (err) {
		return { simError: err };
	}
	await cacheSimResult(deps, req, simVersion, opts, observation);
	return { observation, fromStore: false };
}

/**
 * A store-cached sim at explicit options, for sims whose seed, iteration count
 * or `saveAllValues` differ from the run's own (the set screen). The store key
 * holds every option (`simCacheKey`), so it never answers one question with
 * another's reading. Throws when the sim fails.
 */
export async function runSimAt(
	deps: Deps,
	req: RaidSimRequest,
	simVersion: string,
	opts: SimRunOpts,
): Promise<{ observation: SimObservation; fromStore: boolean }> {
	const outcome = await simOrFailure(deps, req, simVersion, opts);
	if ('simError' in outcome) throw outcome.simError;
	return outcome;
}

/** How many of a group's sims ran and how many came from the store. */
export type SimCounter = { simmed: number; fromStore: number };

/** What `runCounted` reads: the runner, the sim's version and options, and the baseline. */
export type CountedSims = {
	deps: Deps;
	simVersion: string;
	runOpts: SimRunOpts;
	baseline: DpsSample;
};

/** A sim's DPS minus the baseline's, with the standard error of that difference. */
type DeltaSample = { deltaDps: number; se: number };

/**
 * One store-cached sim as a delta against the baseline, counted in `counter`.
 * A failed sim warns with `failure` and comes back as its error's text.
 */
export async function runCounted(sims: CountedSims, request: RaidSimRequest, counter: SimCounter, failure: string): Promise<DeltaSample | SimFailure> {
	const { deps, baseline, runOpts } = sims;
	const outcome = await simOrFailure(deps, request, sims.simVersion, runOpts);
	if ('simError' in outcome) {
		// No warning for a sim the Stop guard refused.
		if (!deps.signal?.aborted) console.warn(failure, outcome.simError);
		return { simError: errorText(outcome.simError) };
	}
	if (outcome.fromStore) counter.fromStore += 1;
	else counter.simmed += 1;
	const sample = sampleOf(outcome.observation, runOpts.iterations);
	return {
		deltaDps: sample.dps - baseline.dps,
		se: Math.sqrt(sample.se ** 2 + baseline.se ** 2),
	};
}

/**
 * Sims each keyed request once with `runCounted`, at the runner's
 * concurrency, in key order. Each key gets its delta or its sim's error, so
 * one failed sim costs only its own key.
 */
export async function simEachOnce(
	sims: CountedSims,
	requests: ReadonlyMap<string, RaidSimRequest>,
	counter: SimCounter,
	failure: string,
): Promise<{ deltas: Map<string, DeltaSample>; errors: Map<string, string> }> {
	const deltas = new Map<string, DeltaSample>();
	const errors = new Map<string, string>();
	await promisePool(
		[...requests].map(([key, request]) => async () => {
			const delta = await runCounted(sims, request, counter, failure);
			if (isSimFailure(delta)) errors.set(key, delta.simError);
			else deltas.set(key, delta);
		}),
		sims.deps.concurrency ?? 1,
	);
	return { deltas, errors };
}

/**
 * A sim the guard below refused to start because the caller's Stop fired. Its
 * own class, so callers can tell it from a sim failure, which fails the
 * ranking.
 */
export class StopRefusedSim extends Error {
	override readonly name = 'StopRefusedSim';

	constructor() {
		super('sim not started: Stop was pressed');
	}
}

/**
 * One stats read, raced against Stop. The listener goes on before the read
 * starts, so an abort fired while the read is being sent is not missed. No
 * timeout: a read that gets no answer means its worker cannot answer sims
 * either, and least-busy routing sends that worker a sim once every healthy
 * worker is busy, so a timeout would only move the hang to a later sim.
 */
export async function readStats(sim: Deps['sim'], req: RaidSimRequest, signal: AbortSignal | undefined): Promise<PlayerStatsObservation> {
	if (signal?.aborted) throw new StopRefusedSim();
	const started = performance.now();
	if (!signal) {
		const observed = await sim.computeStats(req);
		logStatsRead(started);
		return observed;
	}
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => reject(new StopRefusedSim());
		signal.addEventListener('abort', onAbort, { once: true });
	});
	try {
		const read = sim.computeStats(req);
		// After Stop wins the race nobody awaits the read, so its late failure
		// must not become an unhandled rejection.
		read.catch(() => {});
		const observed = await Promise.race([read, stopped]);
		logStatsRead(started);
		return observed;
	} finally {
		signal.removeEventListener('abort', onAbort!);
	}
}

/**
 * Pre-formatted, so a forwarded console line keeps the number. It times
 * reads on either sim transport.
 */
function logStatsRead(started: number): void {
	console.debug(`[upgrades] stats read ${Math.round(performance.now() - started)} ms`);
}

/**
 * `deps` whose sim refuses to start once `deps.signal` has aborted, for the
 * set phase and replication. The candidate loop keeps the plain runner: it
 * turns a failed sim into a dropped row and has its own Stop check.
 */
export function stopGuardedDeps(deps: Deps): Deps {
	const { signal, sim } = deps;
	if (!signal) return deps;
	return {
		...deps,
		sim: {
			version: () => sim.version(),
			run: async (req, opts) => {
				if (signal.aborted) throw new StopRefusedSim();
				return sim.run(req, opts);
			},
			computeStats: async req => {
				if (signal.aborted) throw new StopRefusedSim();
				return sim.computeStats(req);
			},
			...(sim.activeSetBonuses
				? {
						activeSetBonuses: async (req: RaidSimRequest) => {
							if (signal.aborted) throw new StopRefusedSim();
							return sim.activeSetBonuses!(req);
						},
					}
				: {}),
		},
	};
}

async function asInternal<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (err) {
		throw new RankError('internal', err instanceof Error ? err.message : String(err));
	}
}
