/**
 * PORTED verbatim from packages/core/src/se.ts. Pure statistics, no
 * data-source dependency — nothing to adapt.
 */

export const PAIRED_REPLICATE_TOP_N = 8;

export class DegenerateSeedsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DegenerateSeedsError";
  }
}

export function usesPairedReplication(seeds: readonly number[]): boolean {
  return seeds.length > 1;
}

export function assertUsableSeeds(seeds: readonly number[]): void {
  if (!usesPairedReplication(seeds)) return;
  const seen = new Set<number>();
  const repeated = new Set<number>();
  for (const seed of seeds) {
    if (seen.has(seed)) repeated.add(seed);
    seen.add(seed);
  }
  if (repeated.size > 0) {
    const list = [...repeated].sort((a, b) => a - b).join(", ");
    throw new DegenerateSeedsError(
      `seeds must be distinct to measure a spread: ${list} repeated in [${seeds.join(", ")}]. ` +
        `A shared seed repeats bit-identical, so a repeated seed contributes no ` +
        `variance and drives the paired-replicate SE toward a false zero.`
    );
  }
}

export function pairedReplicateSe(deltas: readonly number[]): number {
  if (deltas.length < 2) {
    throw new Error(
      `paired-replicate SE needs at least two deltas, got ${deltas.length}`
    );
  }
  const n = deltas.length;
  const mean = deltas.reduce((sum, d) => sum + d, 0) / n;
  const variance =
    deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / Math.sqrt(n);
}
