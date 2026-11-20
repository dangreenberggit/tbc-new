/**
 * A cheap first pass over the sets whose bonuses a candidate could gain. It
 * picks which sets get the full per-bonus measurement, which costs most of a
 * run's set sims.
 *
 * For a set with `worn` pieces worn whose pool pieces can reach `reach`, at
 * least 2 more: it sims the gear with all those pieces, sending the first k
 * added pieces (in slot order) as normal copies and the rest as copies with no
 * set (`applyCopies`), so the sim counts `worn` + k pieces. The pair is
 * k = 0 against k = `reach` − `worn`. Both sims share a seed and return
 * per-iteration values, so their difference has a paired standard error.
 *
 * `'on'` mode, which the tab uses, sims the pair and applies `SCREEN_ON_RULE`.
 * A dropped set gets no later set sims and no `setBonuses` entry. A set whose
 * sims failed is kept, so a failure never hides a set.
 */

import type { RaidSimRequest, SimObservation, SimRunOpts } from './seams/sim-runner';
import { applyCopies, type BuildFailure, errorText, isBuildFailure } from './set-less-copies';

export type SetScreenMode = 'off' | 'on';

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
 * The `'on'` mode's rule, chosen by scoring rules offline against readings of
 * the pair at several iteration counts and of every piece count: it kept every
 * set worth collecting. Changing any value means scoring
 * it again. Scored again after ticket 886 took the set's own bonus out of the
 * estimate: it kept the same sets on every scored character.
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

export type SetScreenOnSet = {
	setId: number;
	worn: number;
	reach: number;
	/** The pieces added up to `reach`, in slot order. Stored name: "package" means these added pieces. */
	packageItemIds: number[];
	/** DPS with all added pieces counted minus with none; absent if a sim failed. */
	pair: { dps?: number; pairedSe?: number };
	/**
	 * The highest `estimatedDeltaAt` estimate over the reachable counts, if
	 * any: the added pieces' DPS gain with no term for this set's bonuses,
	 * which `measure` adds as the pair's DPS. Recordings store the name.
	 */
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

export type SetScreen = SetScreenOn;

/** The gear with a set's pieces up to `reach` swapped in, and the pieces added. */
export type ScreenGear = {
	request: RaidSimRequest;
	/** The added pieces' slot indices and item ids, in slot order. */
	added: ReadonlyArray<{ slotIndex: number; itemId: number }>;
	/**
	 * Each sim's request with meta repair run for that sim's own hit, one per
	 * entry of `copiesList`: a `BuildFailure` when the request cannot be built,
	 * or undefined when meta repair fails, in which case that sim is skipped
	 * without a warning, as when `gearAt` returns nothing. Absent means every
	 * sim is `request` with its copies applied.
	 */
	requestsFor?: (copiesList: Array<{ setKept: number[]; setLess: number[] }>) => Promise<Array<RaidSimRequest | BuildFailure | undefined>>;
};

export type SetScreenInput = {
	/** Each set's pieces worn and the count the pool can reach. */
	sets: ReadonlyArray<{ setId: number; worn: number; reach: number }>;
	/**
	 * The gear with `setId`'s chosen pieces swapped in up to `threshold`, built the
	 * same way as the later set sims (pieces swapped in with meta repair, then
	 * the request composed). Undefined when it cannot be built.
	 */
	gearAt: (setId: number, threshold: number) => ScreenGear | undefined;
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
};

export type SetScreenOnInput = SetScreenInput & {
	/**
	 * The estimated delta of `setId`'s chosen pieces at `threshold`: their own
	 * deltas added up with the break corrections, the partner choice's
	 * `'sum-of-singles'` estimate, so it needs no extra sim, less the set's bonus each
	 * own delta reached alone. It has no term for this set's bonuses; the
	 * pair's DPS adds them. Undefined when an input is missing.
	 */
	estimatedDeltaAt: (setId: number, threshold: number) => number | undefined;
	/** The baseline sim's per-iteration standard deviation. */
	baselineStdev: number;
};

type ScreenCounter = { simmed: number; fromStore: number };

/** The gear at `reach` and the slots of its added pieces, in slot order. */
function screenGear(input: Pick<SetScreenInput, 'gearAt'>, setId: number, reach: number) {
	const gear = input.gearAt(setId, reach);
	const added = gear ? [...gear.added].sort((a, b) => a.slotIndex - b.slotIndex) : [];
	return { gear, added, slots: added.map(p => p.slotIndex) };
}

/**
 * Runs one of a set's sims for a given k. Each sim catches its own failure, so
 * one failure loses only that sim. With `gear.requestsFor`, the first sim
 * builds all of `counts` in one call.
 */
function countSimmer(
	input: Pick<SetScreenInput, 'runSimAt' | 'seed' | 'signal' | 'onSimFailed' | 'onRequestNotBuilt'>,
	setId: number,
	worn: number,
	gear: ScreenGear | undefined,
	slots: readonly number[],
	counter: ScreenCounter,
	counts: readonly number[],
): (k: number, iterations: number) => Promise<SimObservation | undefined> {
	const copiesAt = (k: number) => ({
		setKept: slots.slice(0, k),
		setLess: slots.slice(k),
	});
	let requests: Promise<Array<RaidSimRequest | BuildFailure | undefined>> | undefined;
	return async (k, iterations) => {
		if (!gear) return undefined;
		const what = `[upgrades] set screen: set ${setId} at ${worn + k} pieces, ${iterations} iterations, not measured`;
		let request: RaidSimRequest | undefined;
		if (gear.requestsFor) {
			requests ??= gear.requestsFor(counts.map(copiesAt));
			const index = counts.indexOf(k);
			if (index < 0) throw new Error(`${what}: count ${k} is not a screened count`);
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
				request = applyCopies(gear.request, copiesAt(k));
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
		const { gear, added, slots } = screenGear(input, setId, reach);
		const simAtCount = countSimmer(input, setId, worn, gear, slots, counter, [0, reach - worn]);
		const low = await simAtCount(0, iterations);
		const high = await simAtCount(reach - worn, iterations);
		const pairDps = low && high ? high.dps - low.dps : undefined;

		let bestEstimate: number | undefined;
		for (let t = Math.max(2, worn + 1); t <= reach; t++) {
			const estimate = input.estimatedDeltaAt(setId, t);
			if (estimate !== undefined && (bestEstimate === undefined || estimate > bestEstimate)) {
				bestEstimate = estimate;
			}
		}
		const measure = bestEstimate !== undefined && pairDps !== undefined ? bestEstimate + pairDps : undefined;

		readings.push({
			setId,
			worn,
			reach,
			packageItemIds: added.map(p => p.itemId),
			pair: {
				...(pairDps !== undefined ? { dps: pairDps } : {}),
				...optionalPairedSe('pairedSe', high, low, iterations),
			},
			...(bestEstimate !== undefined ? { bestStats: bestEstimate } : {}),
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
	const lastKeptMeasure = ranked[rule.keep - 1]!.measure;
	const width = rule.bandC * Math.SQRT2 * sigma!;
	ranked.forEach((r, i) => {
		if (i < rule.keep) out.set(r.setId, { kept: true, reason: 'top-k' });
		else if (r.measure >= lastKeptMeasure - width) {
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
