/**
 * Paired replication: the top rows re-simmed at every seed against the
 * baseline at the same seed, and the sim counts the progress events report.
 */

import { type Cutoff, meetsCutoff } from './cutoff';
import type { RunContext } from './rank-setup';
import { type RankedItem, RankError } from './rank-types';
import { isReplicable, PAIRED_REPLICATE_TOP_N, pairedReplicateSe, usesPairedReplication } from './se';
import type { RaidSimRequest, SimObservation } from './seams/sim-runner';
import { simOrFailure, StopRefusedSim } from './sim-calls';

/**
 * The sim counts the progress events report. One object per run, so the
 * candidate loop, `replicateTopItems` and `bumpProgress` add to the same
 * counts.
 */
export type SimCounts = { done: number; total: number };

/** A replicated row and its paired deltas, one per seed. */
export type ReplicatedRow = { item: RankedItem; deltas: number[] };

/**
 * The top rows' paired deltas, one per seed. It writes nothing to the rows,
 * so a Stop part-way through leaves them as the candidate loop left them.
 */
export async function replicateTopItems(
	ctx: RunContext,
	simCounts: SimCounts,
	ranked: RankedItem[],
	winningRequests: ReadonlyMap<number, RaidSimRequest>,
): Promise<ReplicatedRow[]> {
	const { seeds, onProgress, request } = ctx;
	const top = usesPairedReplication(seeds) ? ranked.filter(isReplicable).slice(0, PAIRED_REPLICATE_TOP_N) : [];
	// The total sent so far budgeted re-sims for up to top-N rows; only now is
	// the number of rows known, so the total is restated as the sims done
	// plus the sims this function will run.
	simCounts.total = simCounts.done + (top.length === 0 ? 0 : (seeds.length - 1) * (1 + top.length));
	onProgress?.({
		stage: 'simming',
		done: simCounts.done,
		total: simCounts.total,
	});
	if (top.length === 0) return [];
	const baselineBySeed = new Map<number, number>();
	for (const s of seeds) {
		baselineBySeed.set(s, (await simFor(ctx, request, s)).dps);
		bumpProgress(ctx, simCounts, s);
	}

	const replicated: ReplicatedRow[] = [];
	for (const item of top) {
		const candReq = winningRequests.get(item.itemId);
		if (!candReq) {
			throw new RankError('internal', `no recorded request for ranked item ${item.itemId} (${item.name}); ` + `paired replication cannot re-sim it`);
		}
		const deltas: number[] = [];
		for (const s of seeds) {
			const obs = await simFor(ctx, candReq, s);
			deltas.push(obs.dps - baselineBySeed.get(s)!);
			bumpProgress(ctx, simCounts, s);
		}
		replicated.push({ item, deltas });
	}
	return replicated;
}

/**
 * Counts one replication sim. A first-seed sim is not counted: the baseline
 * and the candidate loop already ran it with that seed.
 */
function bumpProgress(ctx: RunContext, simCounts: SimCounts, seedForRun: number): void {
	if (seedForRun === ctx.seeds[0]) return;
	simCounts.done += 1;
	ctx.onProgress?.({
		stage: 'simming',
		done: simCounts.done,
		total: simCounts.total,
	});
}

/**
 * One replication sim at `seedForRun`, through the Stop guard. A refused
 * sim rethrows `StopRefusedSim`; any other failure fails the run.
 */
async function simFor(ctx: RunContext, req: RaidSimRequest, seedForRun: number): Promise<SimObservation> {
	const opts = { seed: seedForRun, iterations: ctx.iterations };
	// The store goes through `guardedDeps` too: `stopGuardedDeps` keeps
	// `deps`'s own store, and only the sim is guarded.
	const outcome = await simOrFailure(ctx.guardedDeps, req, ctx.simVersion, opts);
	if ('simError' in outcome) {
		const err = outcome.simError;
		if (err instanceof StopRefusedSim) throw err;
		throw new RankError('sim-failed', err instanceof Error ? err.message : String(err));
	}
	return outcome.observation;
}

/**
 * Puts each replicated row's paired figures in place of the candidate
 * loop's: the mean delta, its standard error, and the cutoff test.
 */
export function applyReplicatedDeltas(replicated: readonly ReplicatedRow[], baselineDps: number, cutoff: Cutoff): void {
	for (const { item, deltas } of replicated) {
		item.se = pairedReplicateSe(deltas);
		item.seMethod = 'paired-replicate';
		item.deltaDps = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
		item.deltaPct = baselineDps === 0 ? 0 : (item.deltaDps / baselineDps) * 100;
		item.belowCutoff = !meetsCutoff(item.deltaDps, cutoff);
	}
}
