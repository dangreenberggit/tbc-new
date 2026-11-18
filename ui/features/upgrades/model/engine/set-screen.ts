/**
 * A cheap first pass over the sets whose bonuses a candidate could gain. It
 * picks which sets get the full per-bonus measurement, which costs most of a
 * run's set sims.
 *
 * For a set with `worn` pieces worn whose pool pieces can reach `reach`, at
 * least 2 more: it sims the gear with all those pieces, sending the first k
 * added pieces (in slot order) as normal copies and the rest as copies with no
 * set (`applyCopies`), so the sim counts `worn` + k pieces. Each k is one of
 * `rungs`, and a `pairs` entry is k = 0 against k = `reach` − `worn`. They all
 * share a seed and return per-iteration values, so the difference of two has a
 * paired standard error.
 *
 * `'record'` mode runs the pair at several iteration counts and every k, for
 * scoring rules offline, and drops nothing. `'on'` mode, which the tab uses,
 * sims only the pair and applies `SCREEN_ON_RULE`. A dropped set gets no later
 * set sims and no `setBonuses` entry. A set whose sims failed is kept, so a
 * failure never hides a set.
 */

import type { RaidSimRequest, SimObservation, SimRunOpts } from './seams/sim-runner';
import { applyCopies, type BuildFailure, errorText, isBuildFailure } from './set-less-copies';

export type SetScreenMode = 'off' | 'record' | 'on';

/** Iteration counts for `pairs`, and for `rungs`, in `'record'` mode. */
export const SCREEN_PAIR_ITERATIONS: readonly number[] = [10, 100, 300, 1000];
export const SCREEN_LADDER_ITERATIONS: readonly number[] = [100, 300, 1000];

export type ScreenOnRule = {
	/** `'M2'`: `bestStats` plus the pair's DPS. */
	measure: 'M2';
	iterations: number;
	/** How many sets with the highest `measure` are always kept. */
	keep: number;
	/** Also keep sets within `bandC` · √2 · `sigma` of the `keep`-th `measure`. */
	bandC: number;
	/** Drop a set whose pair differs by exactly 0 DPS. */
	dropExactZero: boolean;
	/** `sigma` = `sigmaBoundScale` · √2 · baseline stdev / √`iterations`. */
	sigmaBoundScale: number;
};

/**
 * The `'on'` mode's rule, chosen by scoring rules offline against `'record'`
 * results: it kept every set worth collecting. Changing any value means scoring
 * it again.
 */
export const SCREEN_ON_RULE = {
	measure: 'M2',
	iterations: 300,
	keep: 2,
	bandC: 1,
	dropExactZero: true,
	sigmaBoundScale: 1,
} as const;

export type ScreenReason = 'exact-zero' | 'readings-absent' | 'below-zero' | 'top-k' | 'band' | 'outside-band';

export type SetScreenPair = {
	iterations: number;
	/** DPS with all added pieces counted minus with none; absent if a sim failed. */
	dps?: number;
	/** sd(a_i − b_i)/√N over the two sims' per-iteration values. */
	pairedSe?: number;
};

export type SetScreenRung = {
	iterations: number;
	/** How many of the set's pieces the sim counts. */
	count: number;
	/** This sim's DPS. Absent when it failed. */
	dps?: number;
	se?: number;
	/** The paired standard error of this sim minus the one a count below. */
	pairedSeToPrev?: number;
};

export type SetScreenSet = {
	setId: number;
	worn: number;
	reach: number;
	/** The pieces added up to `reach`, in slot order. */
	packageItemIds: number[];
	pairs: SetScreenPair[];
	/** Grouped by iteration count, then in count order. */
	rungs: SetScreenRung[];
};

export type SetScreenRecord = {
	mode: 'record';
	seed: number;
	pairIterations: number[];
	ladderIterations: number[];
	sets: SetScreenSet[];
	/** Sims sent to the runner, failed ones included. */
	simmed: number;
	fromStore: number;
};

export type SetScreenOnSet = {
	setId: number;
	worn: number;
	reach: number;
	/** The pieces added up to `reach`, in slot order. */
	packageItemIds: number[];
	/** DPS with all added pieces counted minus with none; absent if a sim failed. */
	pair: { dps?: number; pairedSe?: number };
	/** The highest `statsAt` estimate over the reachable counts, if any. */
	bestStats?: number;
	/** `bestStats + pair.dps`, absent when either is. */
	measure?: number;
	kept: boolean;
	reason: ScreenReason;
};

export type SetScreenOn = {
	mode: 'on';
	seed: number;
	iterations: number;
	rule: Readonly<ScreenOnRule>;
	/** Absent when the baseline stdev is not a finite number. */
	sigma?: number;
	sets: SetScreenOnSet[];
	/** Sims sent to the runner, failed ones included. */
	simmed: number;
	fromStore: number;
};

export type SetScreen = SetScreenRecord | SetScreenOn;

/** The gear with a set's pieces up to `reach` swapped in, and the pieces added. */
export type ScreenPackage = {
	request: RaidSimRequest;
	/** The added pieces' slot indices and item ids, in slot order. */
	added: ReadonlyArray<{ slotIndex: number; itemId: number }>;
	/**
	 * Each sim's request with meta repair run for that sim's own hit, one per
	 * entry of `copiesList`: a `BuildFailure` when the request cannot be built,
	 * or undefined when meta repair fails, in which case that sim is skipped
	 * without a warning, as when `packageAt` returns nothing. Absent means every
	 * sim is `request` with its copies applied.
	 */
	requestsFor?: (copiesList: Array<{ setKept: number[]; setLess: number[] }>) => Promise<Array<RaidSimRequest | BuildFailure | undefined>>;
};

export type SetScreenInput = {
	/** Each set's pieces worn and the count the pool can reach. */
	sets: ReadonlyArray<{ setId: number; worn: number; reach: number }>;
	/**
	 * The gear with `setId`'s chosen pieces swapped in up to `count`, built the
	 * same way as the later set sims (pieces swapped in with meta repair, then
	 * the request composed). Undefined when it cannot be built.
	 */
	packageAt: (setId: number, count: number) => ScreenPackage | undefined;
	/** A store-cached sim with explicit options. Throws when the sim fails. */
	runSimAt: (request: RaidSimRequest, opts: SimRunOpts) => Promise<{ observation: SimObservation; fromStore: boolean }>;
	seed: number;
	/**
	 * The caller's Stop. Once it has aborted, a failed sim is the runner refusing
	 * it and the caller throws the results away, so no warning is written.
	 */
	signal?: AbortSignal;
	/** Each failed sim's error, except a sim Stop refused. */
	onSimFailed?: (setId: number, error: string) => void;
	/** The error of each sim request that could not be built. */
	onRequestNotBuilt?: (setId: number, error: string) => void;
	pairIterations?: readonly number[];
	ladderIterations?: readonly number[];
};

export type SetScreenOnInput = Omit<SetScreenInput, 'pairIterations' | 'ladderIterations'> & {
	/**
	 * An estimate for `setId`'s pieces at `count` with no extra sim: the sum of
	 * each piece's own swap gain, corrected for worn bonuses they break together,
	 * as the `'sum-of-singles'` partner rule does. Undefined when an input is
	 * missing.
	 */
	statsAt: (setId: number, count: number) => number | undefined;
	/** The baseline sim's per-iteration standard deviation. */
	baselineStdev: number;
};

type ScreenCounter = { simmed: number; fromStore: number };

/** The gear at `reach` and the slots of its added pieces, in slot order. */
function screenPackage(input: Pick<SetScreenInput, 'packageAt'>, setId: number, reach: number) {
	const pkg = input.packageAt(setId, reach);
	const added = pkg ? [...pkg.added].sort((a, b) => a.slotIndex - b.slotIndex) : [];
	return { pkg, added, slots: added.map(p => p.slotIndex) };
}

/**
 * Runs one of a set's sims for a given k, shared by both modes so an `'on'` pair
 * is the same request, with the same options, as a `'record'` pair at that
 * iteration count. Each sim catches its own failure, so one failure loses only
 * that sim. With `pkg.requestsFor`, the first sim builds all of `rungs` in one
 * call.
 */
function rungSimmer(
	input: Pick<SetScreenInput, 'runSimAt' | 'seed' | 'signal' | 'onSimFailed' | 'onRequestNotBuilt'>,
	setId: number,
	worn: number,
	pkg: ScreenPackage | undefined,
	slots: readonly number[],
	counter: ScreenCounter,
	rungs: readonly number[],
): (k: number, iterations: number) => Promise<SimObservation | undefined> {
	const copiesAt = (k: number) => ({
		setKept: slots.slice(0, k),
		setLess: slots.slice(k),
	});
	let requests: Promise<Array<RaidSimRequest | BuildFailure | undefined>> | undefined;
	return async (k, iterations) => {
		if (!pkg) return undefined;
		const what = `[upgrades] set screen: set ${setId} at ${worn + k} pieces, ${iterations} iterations, not measured`;
		let request: RaidSimRequest | undefined;
		if (pkg.requestsFor) {
			requests ??= pkg.requestsFor(rungs.map(copiesAt));
			const index = rungs.indexOf(k);
			if (index < 0) throw new Error(`${what}: rung ${k} is not a screened rung`);
			const built = (await requests)[index];
			if (built === undefined) return undefined;
			if (isBuildFailure(built)) {
				if (!input.signal?.aborted) {
					console.warn(what, built.buildError);
					input.onRequestNotBuilt?.(setId, built.buildError);
				}
				return undefined;
			}
			request = built;
		} else {
			try {
				request = applyCopies(pkg.request, copiesAt(k));
			} catch (err) {
				console.warn(what, err);
				input.onRequestNotBuilt?.(setId, errorText(err));
				return undefined;
			}
		}
		try {
			const { observation, fromStore: hit } = await input.runSimAt(request, {
				seed: input.seed,
				iterations,
				saveAllValues: true,
			});
			if (hit) counter.fromStore += 1;
			else counter.simmed += 1;
			return observation;
		} catch (err) {
			counter.simmed += 1;
			if (!input.signal?.aborted) {
				console.warn(what, err);
				input.onSimFailed?.(setId, errorText(err));
			}
			return undefined;
		}
	};
}

export async function recordSetScreen(input: SetScreenInput): Promise<SetScreenRecord> {
	const pairIterations = [...(input.pairIterations ?? SCREEN_PAIR_ITERATIONS)];
	const ladderIterations = [...(input.ladderIterations ?? SCREEN_LADDER_ITERATIONS)];
	const counter: ScreenCounter = { simmed: 0, fromStore: 0 };
	const sets: SetScreenSet[] = [];

	for (const { setId, worn, reach } of input.sets) {
		if (reach - worn < 2) continue;
		const { pkg, added, slots } = screenPackage(input, setId, reach);
		const top = reach - worn;
		const rungAt = rungSimmer(
			input,
			setId,
			worn,
			pkg,
			slots,
			counter,
			Array.from({ length: top + 1 }, (_, k) => k),
		);

		const pairs: SetScreenPair[] = [];
		for (const iterations of pairIterations) {
			const low = await rungAt(0, iterations);
			const high = await rungAt(top, iterations);
			pairs.push({
				iterations,
				...(low && high ? { dps: high.dps - low.dps } : {}),
				...optionalPairedSe('pairedSe', high, low, iterations),
			});
		}

		const rungs: SetScreenRung[] = [];
		for (const iterations of ladderIterations) {
			let below: SimObservation | undefined;
			for (let k = 0; k <= top; k++) {
				const obs = await rungAt(k, iterations);
				rungs.push({
					iterations,
					count: worn + k,
					...(obs ? { dps: obs.dps, se: obs.stdev / Math.sqrt(iterations) } : {}),
					...(k > 0 ? optionalPairedSe('pairedSeToPrev', obs, below, iterations) : {}),
				});
				below = obs;
			}
		}

		sets.push({
			setId,
			worn,
			reach,
			packageItemIds: added.map(p => p.itemId),
			pairs,
			rungs,
		});
	}

	return {
		mode: 'record',
		seed: input.seed,
		pairIterations,
		ladderIterations,
		sets,
		simmed: counter.simmed,
		fromStore: counter.fromStore,
	};
}

/**
 * The `'on'` mode: the pair at `SCREEN_ON_RULE.iterations` for each set that can
 * gain 2 or more pieces, in set id order, then `applyScreenRule`. The caller
 * keeps every other set.
 */
export async function runSetScreenOn(input: SetScreenOnInput): Promise<SetScreenOn> {
	const rule = SCREEN_ON_RULE;
	const iterations = rule.iterations;
	const counter: ScreenCounter = { simmed: 0, fromStore: 0 };
	const readings: Omit<SetScreenOnSet, 'kept' | 'reason'>[] = [];

	for (const { setId, worn, reach } of [...input.sets].sort((a, b) => a.setId - b.setId)) {
		if (reach - worn < 2) continue;
		const { pkg, added, slots } = screenPackage(input, setId, reach);
		const rungAt = rungSimmer(input, setId, worn, pkg, slots, counter, [0, reach - worn]);
		const low = await rungAt(0, iterations);
		const high = await rungAt(reach - worn, iterations);
		const pairDps = low && high ? high.dps - low.dps : undefined;

		let bestStats: number | undefined;
		for (let t = Math.max(2, worn + 1); t <= reach; t++) {
			const stats = input.statsAt(setId, t);
			if (stats !== undefined && (bestStats === undefined || stats > bestStats)) {
				bestStats = stats;
			}
		}
		const measure = bestStats !== undefined && pairDps !== undefined ? bestStats + pairDps : undefined;

		readings.push({
			setId,
			worn,
			reach,
			packageItemIds: added.map(p => p.itemId),
			pair: {
				...(pairDps !== undefined ? { dps: pairDps } : {}),
				...optionalPairedSe('pairedSe', high, low, iterations),
			},
			...(bestStats !== undefined ? { bestStats } : {}),
			...(measure !== undefined ? { measure } : {}),
		});
	}

	const sigma = Number.isFinite(input.baselineStdev) ? (rule.sigmaBoundScale * Math.SQRT2 * input.baselineStdev) / Math.sqrt(iterations) : undefined;
	const verdicts = applyScreenRule(
		readings.map(r => ({
			setId: r.setId,
			...(r.pair.dps !== undefined ? { pairDps: r.pair.dps } : {}),
			...(r.measure !== undefined ? { measure: r.measure } : {}),
		})),
		sigma,
		rule,
	);

	return {
		mode: 'on',
		seed: input.seed,
		iterations,
		rule,
		...(sigma !== undefined ? { sigma } : {}),
		sets: readings.map(r => ({ ...r, ...verdicts.get(r.setId)! })),
		simmed: counter.simmed,
		fromStore: counter.fromStore,
	};
}

/**
 * Which sets the `'on'` mode keeps, and why. It must match the rule the offline
 * scoring applied, or that scoring no longer holds. In set id order:
 *
 * 1. a pair of exactly 0 DPS is dropped, before the next check;
 * 2. a missing `measure` or `sigma` keeps the set, without ranking it;
 * 3. `measure` + 2 · `sigma` < 0 is dropped;
 * 4. the rest are sorted by `measure` (highest first, then set id), and the
 *    first `keep` are kept;
 * 5. another set within `bandC` · √2 · `sigma` of the `keep`-th `measure`
 *    (inclusive) is kept;
 * 6. the rest are dropped.
 */
export function applyScreenRule(
	sets: ReadonlyArray<{ setId: number; pairDps?: number; measure?: number }>,
	sigma: number | undefined,
	rule: Readonly<ScreenOnRule> = SCREEN_ON_RULE,
): Map<number, { kept: boolean; reason: ScreenReason }> {
	const out = new Map<number, { kept: boolean; reason: ScreenReason }>();
	const ranked: Array<{ setId: number; measure: number }> = [];
	for (const set of [...sets].sort((a, b) => a.setId - b.setId)) {
		if (rule.dropExactZero && set.pairDps === 0) {
			out.set(set.setId, { kept: false, reason: 'exact-zero' });
			continue;
		}
		if (set.measure === undefined || sigma === undefined || !Number.isFinite(sigma)) {
			out.set(set.setId, { kept: true, reason: 'readings-absent' });
			continue;
		}
		if (set.measure + 2 * sigma < 0) {
			out.set(set.setId, { kept: false, reason: 'below-zero' });
			continue;
		}
		ranked.push({ setId: set.setId, measure: set.measure });
	}
	ranked.sort((a, b) => (a.measure !== b.measure ? b.measure - a.measure : a.setId - b.setId));
	if (ranked.length <= rule.keep) {
		for (const r of ranked) out.set(r.setId, { kept: true, reason: 'top-k' });
		return out;
	}
	const measureK = ranked[rule.keep - 1]!.measure;
	const width = rule.bandC * Math.SQRT2 * sigma!;
	ranked.forEach((r, i) => {
		if (i < rule.keep) out.set(r.setId, { kept: true, reason: 'top-k' });
		else if (r.measure >= measureK - width) {
			out.set(r.setId, { kept: true, reason: 'band' });
		} else out.set(r.setId, { kept: false, reason: 'outside-band' });
	});
	return out;
}

/** `{ [field]: sd(a_i − b_i)/√N }`, or nothing when either side lacks N values. */
function optionalPairedSe<K extends string>(field: K, a: SimObservation | undefined, b: SimObservation | undefined, iterations: number): { [P in K]?: number } {
	const se = pairedSe(a?.allValues, b?.allValues, iterations);
	return (se === undefined ? {} : { [field]: se }) as { [P in K]?: number };
}

/**
 * The standard error of the mean per-iteration difference of two sims that
 * share a seed: sd(a_i − b_i)/√N, the batch sim's paired error
 * (sim/core/bulk/statistics.go). Undefined unless both have N values, N ≥ 2.
 */
export function pairedSe(a: readonly number[] | undefined, b: readonly number[] | undefined, iterations: number): number | undefined {
	if (!a || !b || iterations < 2 || a.length !== iterations || b.length !== iterations) {
		return undefined;
	}
	let sum = 0;
	for (let i = 0; i < iterations; i++) sum += a[i]! - b[i]!;
	const mean = sum / iterations;
	let squares = 0;
	for (let i = 0; i < iterations; i++) {
		const d = a[i]! - b[i]! - mean;
		squares += d * d;
	}
	return Math.sqrt(squares / (iterations - 1)) / Math.sqrt(iterations);
}
