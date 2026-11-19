/**
 * Standard error by paired replication (`'paired-replicate'`): rerun a delta on distinct
 * seeds and report `sd(deltas) / sqrt(n)`. It orders the top of the list more finely; it
 * does not correct any number.
 */

/** The most rows paired replication re-sims. */
export const PAIRED_REPLICATE_TOP_N = 8;

/** Seeds each replicated row is re-simmed on. */
export const DEFAULT_SEED_COUNT = 5;

export function isReplicable(row: { readonly belowCutoff: boolean; readonly simmed?: false }): boolean {
	return !row.belowCutoff && row.simmed !== false;
}

/**
 * Seeds that cannot produce a spread. Its own class so `rank.ts` maps it to `RankError`
 * kind `internal` (bad caller input) without matching strings.
 */
export class DegenerateSeedsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DegenerateSeedsError';
	}
}

/** More than one seed in `RankInput.seeds` turns replication on; no second flag. */
export function usesPairedReplication(seeds: readonly number[]): boolean {
	return seeds.length > 1;
}

/**
 * A repeated seed reruns bit-identical and drives the SE toward a false zero that reads as
 * precision, so it throws instead.
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
 * Seeds must be distinct and at least `iterations` apart to be independent. `iterations`
 * is required so the spacing check cannot be skipped by leaving it out; a caller that
 * wants only distinct seeds calls `assertDistinctSeeds` by name.
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
 * `count` seeds from `base`, spaced by `iterations` so no two runs share a per-iteration
 * RNG stream: iteration i reseeds to `RandomSeed + i` (`reseedRands`, sim/core/sim.go).
 * sim/core/sim_concurrent.go spaces its splits the same way.
 */
export function replicateSeeds(base: number, count: number, iterations: number): number[] {
	return Array.from({ length: count }, (_, k) => base + k * iterations);
}

/**
 * `SE = sd(deltas) / sqrt(n)`, with the sample (`n - 1`) sd: the seeds sample the seed
 * space, and the population form would understate the spread.
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
