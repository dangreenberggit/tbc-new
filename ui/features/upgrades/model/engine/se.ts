/**
 * Paired-replicate standard error: replicate a delta across distinct seeds and
 * report `sd(deltas) / sqrt(n)`, with no distributional assumptions. This buys
 * **resolution, not correctness**: how finely the top of the list can be
 * ordered, not a fix to any number below it.
 */

/** Replicate the top 8 items only: 5× sims on 8 items, not on the whole list. */
export const PAIRED_REPLICATE_TOP_N = 8;

/**
 * A caller passed seeds that cannot produce a spread. Its own class so
 * `rank.ts` can map it to `RankError` kind `internal` without string-matching:
 * the other kinds fault the character, the log or the sim, and this is bad
 * input from the caller.
 */
export class DegenerateSeedsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DegenerateSeedsError';
	}
}

/**
 * `RankInput.seeds` is the switch: more than one seed enables paired
 * replication. No second flag, so the two cannot disagree.
 */
export function usesPairedReplication(seeds: readonly number[]): boolean {
	return seeds.length > 1;
}

/**
 * Every seed must be distinct: a shared seed repeats **bit-identical**, so
 * replicating one seed yields `sd(deltas) = 0` and an SE of zero, an artifact
 * that reads as precision. Fail loudly instead of reporting it.
 */
export function assertDistinctSeeds(seeds: readonly number[]): void {
	if (!usesPairedReplication(seeds)) return;
	const seen = new Set<number>();
	const repeated = new Set<number>();
	for (const seed of seeds) {
		if (seen.has(seed)) repeated.add(seed);
		seen.add(seed);
	}
	if (repeated.size > 0) {
		const list = [...repeated].sort((a, b) => a - b).join(', ');
		throw new DegenerateSeedsError(
			`seeds must be distinct to measure a spread: ${list} repeated in [${seeds.join(', ')}]. ` +
				`A shared seed repeats bit-identical, so a repeated seed contributes no ` +
				`variance and drives the paired-replicate SE toward a false zero (PLAN.md §10).`,
		);
	}
}

/**
 * The full guard on a multi-seed replication: distinct **and** spaced far
 * enough apart to be independent.
 *
 * `iterations` is required so the spacing check cannot be skipped by
 * omission. A caller that wants distinctness alone calls
 * `assertDistinctSeeds` by name, so the weaker check is a visible choice.
 */
export function assertUsableSeeds(seeds: readonly number[], iterations: number): void {
	assertDistinctSeeds(seeds);
	if (!usesPairedReplication(seeds)) return;
	const ordered = [...seeds].sort((a, b) => a - b);
	for (let i = 1; i < ordered.length; i += 1) {
		const lo = ordered[i - 1]!;
		const hi = ordered[i]!;
		const gap = hi - lo;
		if (gap >= iterations) continue;
		throw new DegenerateSeedsError(
			`seeds must be at least ${iterations} apart to be independent replicates: ` +
				`${lo} and ${hi} are ${gap} apart in [${seeds.join(', ')}]. ` +
				`A run of N iterations from seed S consumes the per-iteration streams ` +
				`S..S+N-1, so these two share ${iterations - gap} of ${iterations} streams ` +
				`and their spread measures overlap rather than simulation noise ` +
				`(ticket 236; upstream vendor/tbc-new-fork/sim/core/sim.go:248-251).`,
		);
	}
}

/**
 * `count` seeds from `base`, spaced by `iterations` so no two runs share a
 * per-iteration RNG stream: iteration i of a run reseeds to `RandomSeed + i`
 * (`reseedRands`, sim/core/sim.go). Derived rather than pinned, so the spacing
 * follows the iteration count. Upstream spaces concurrent splits the same way
 * (sim/core/sim_concurrent.go).
 *
 * A single five-seed sd ratio cannot test independence: at n=5 the sample sd
 * has 34 % relative error, so it cannot separate 0.5 from 1.0.
 */
export function replicateSeeds(base: number, count: number, iterations: number): number[] {
	return Array.from({ length: count }, (_, k) => base + k * iterations);
}

/**
 * `SE = sd(deltas) / sqrt(n)`, with `sd` the sample standard deviation.
 *
 * Sample (`n - 1`) rather than population: the seeds are a sample of the seed
 * space, and the population form would understate the spread, toward the false
 * precision this method exists to avoid.
 */
export function pairedReplicateSe(deltas: readonly number[]): number {
	if (deltas.length < 2) {
		throw new Error(`paired-replicate SE needs at least two deltas, got ${deltas.length}`);
	}
	const n = deltas.length;
	const mean = deltas.reduce((sum, d) => sum + d, 0) / n;
	const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
	return Math.sqrt(variance) / Math.sqrt(n);
}
