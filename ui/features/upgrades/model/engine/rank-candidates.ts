/**
 * The candidate loop of a run: one sim per candidate and legal slot against the baseline,
 * and the row each priced candidate gets. A Stop leaves a placeholder row for every
 * candidate it kept from running.
 */

import { type GemContext, metaSocketUnpriced } from './candidate-gems';
import { type Cutoff, meetsCutoff } from './cutoff';
import { candidateSwapWithRepairs } from './gear-swap';
import { type BaselineHitBudget, CandidateHitReadFailed, candidateRepairGems } from './hit-budget';
import { type GemRecolor, MetaRepairError } from './meta-repair';
import { type PoolEntry, type SimSlotName, simSlotsForPoolSlot } from './pool';
import { promisePool } from './promise-pool';
import type { SimCounts } from './rank-replication';
import type { EligibleCandidates, RunContext } from './rank-setup';
import type { Deps, RankedItem } from './rank-types';
import type { CandidateSkip } from './run-notes';
import { PAIRED_REPLICATE_TOP_N, usesPairedReplication } from './se';
import type { RaidSimRequest } from './seams/sim-runner';
import { setBreakNote } from './set-bonus';
import { type OwnDelta, sampleOf } from './set-value';
import { simOrFailure, StopRefusedSim } from './sim-calls';
import { SIM_ORDER, type SimItemSpec } from './slots';

type BestSwap = {
	deltaDps: number;
	se: number;
	request: RaidSimRequest;
	slotChoice?: SimSlotName;
	slotIndex: number;
	setBonusNote?: string;
	repairRecolors: readonly GemRecolor[];
	/** Worn items the winning attempt took off beyond the swap itself. */
	removed: readonly { slotIndex: number; itemId: number }[];
	candidateGems: readonly number[];
};

/** What the candidate loop hands the rest of the run. */
export type CandidateResults = {
	ranked: RankedItem[];
	winningRequests: Map<number, RaidSimRequest>;
	candidateSkips: CandidateSkip[];
	ownDeltasByItemId: Map<number, OwnDelta>;
	/** The candidates left after the cap, whether or not Stop let them run; the set phase walks them. */
	simCandidates: PoolEntry[];
	/** Whether Stop fired, read again after the pool drains. */
	aborted: boolean;
};

/**
 * What every candidate of one run reads: the run, its pool, the baseline it is priced
 * against, the skips list a failed slot is added to, and the candidates' sim count.
 */
type CandidateLoop = {
	ctx: RunContext;
	pool: EligibleCandidates;
	baselineHitBudget: BaselineHitBudget;
	baselineDps: number;
	candidateSkips: CandidateSkip[];
	/**
	 * The sims the candidates run, sent with each of the candidates' `simming` events so the
	 * tab can count the stage in sims, as the Bulk sim counts its own
	 * (`features/bulk/model/progress.ts:60-66`): one per legal slot (`legalSlotNames`), less
	 * each slot the store answered or whose hit read or repair failed. After a Stop the slots
	 * left unrun stay in it; the tab hides the time left from a Stop on.
	 */
	candidateSims: { count: number };
};

/**
 * Every candidate after the cap, priced through a `promisePool` on `deps` (the candidate
 * loop runs without the Stop guard). It sends the progress total first and counts one step
 * per candidate, however many slots it is simmed in. After a Stop, the candidates that never
 * ran get placeholder rows.
 */
export async function runCandidates(
	ctx: RunContext,
	pool: EligibleCandidates,
	baselineHitBudget: BaselineHitBudget,
	baselineDps: number,
	simCounts: SimCounts,
): Promise<CandidateResults> {
	const { input, deps, onProgress, cutoff, seeds } = ctx;
	const { equippedIds, ordered } = pool;
	const { gems } = baselineHitBudget;
	const ranked: RankedItem[] = [];
	const winningRequests = new Map<number, RaidSimRequest>();
	const candidateSkips: CandidateSkip[] = [];
	const ownDeltasByItemId = new Map<number, OwnDelta>();

	const loop: CandidateLoop = { ctx, pool, baselineHitBudget, baselineDps, candidateSkips, candidateSims: { count: 0 } };

	/**
	 * One candidate's slot-attempt loop, run as a `promisePool` task. Its
	 * writes to the shared collections are safe because JS interleaves only
	 * at `await`. Output never depends on finish order: `ranked` is sorted by
	 * `deltaDps` after the pool drains and `candidateSkips` by item id, so any
	 * `concurrency` gives byte-identical output.
	 */
	async function runCandidate(entry: PoolEntry): Promise<void> {
		const worn = equippedIds.has(entry.itemId);
		const best = await bestSwapFor(loop, entry);
		// Stop refused a hit read: the row is left to the Stop placeholder, and
		// the candidate is not counted.
		if (best === 'stopped') return;

		simCounts.done += 1;
		onProgress?.({ stage: 'simming', done: simCounts.done, total: totalSims, candidateSims: loop.candidateSims.count });

		if (!best) return;

		ownDeltasByItemId.set(entry.itemId, {
			itemId: entry.itemId,
			slotIndex: best.slotIndex,
			deltaDps: best.deltaDps,
			se: best.se,
		});

		const item = rankedRow(entry, best, worn, baselineDps, cutoff, gems);
		ranked.push(item);
		winningRequests.set(entry.itemId, best.request);
		onProgress?.({ kind: 'row', row: item });
	}

	// Every eligible candidate gets a full-iteration sim; the cap keeps the
	// first N items of the EP order the player does not wear, plus every worn
	// row. Worn rows are kept anyway and the list leaves them out, so one
	// counted against N would leave the list a row short.
	const candidateCap = input.candidateCap ?? ordered.length;
	const keptNotWorn = new Set(ordered.filter(e => !equippedIds.has(e.itemId)).slice(0, candidateCap));
	const simCandidates = ordered.filter(e => keptNotWorn.has(e) || equippedIds.has(e.itemId));

	// Counted here, after the cap decides the full-iteration set. An upper
	// bound until `replicateTopItems` restates it with the rows it re-sims.
	const replicaSims = usesPairedReplication(seeds) ? (seeds.length - 1) * (1 + Math.min(PAIRED_REPLICATE_TOP_N, simCandidates.length)) : 0;
	const totalSims = 1 + simCandidates.length + replicaSims;
	simCounts.total = totalSims;
	loop.candidateSims.count = simCandidates.reduce((n, entry) => n + legalSlotNames(loop, entry).length, 0);
	onProgress?.({ stage: 'simming', done: simCounts.done, total: totalSims, candidateSims: loop.candidateSims.count });

	const signal = deps.signal;
	let aborted = await dispatchUntilStop(deps, simCandidates, runCandidate);
	// Re-read after the pool drains: an abort raised while the last task was
	// in flight skips nothing, so the loop above never sets the flag, yet the
	// run must still stop before replication and the set-bonus sims.
	if (signal?.aborted) aborted = true;
	// A skipped candidate (failed repair or sim) is already disclosed in
	// `substitutions`, and never reaches `ownDeltasByItemId`, so
	// filtering on that map alone would re-add it as a Stop placeholder.
	const skippedIds = new Set(candidateSkips.map(s => s.itemId));
	const unsimmedCandidates = aborted ? simCandidates.filter(c => !ownDeltasByItemId.has(c.itemId) && !skippedIds.has(c.itemId)) : [];
	for (const entry of unsimmedCandidates) {
		ranked.push(placeholderRow(entry, placeholderSlotChoice(loop, entry), equippedIds.has(entry.itemId)));
	}
	// Deterministic regardless of completion order, so `substitutions`
	// reads the same on every run at every `concurrency`.
	candidateSkips.sort((a, b) => a.itemId - b.itemId);

	return { ranked, winningRequests, candidateSkips, ownDeltasByItemId, simCandidates, aborted };
}

/**
 * Each candidate's task through a `promisePool` at `deps.concurrency`. Returns whether a
 * Stop kept a task from starting; the caller reads `signal` again once the pool drains.
 */
async function dispatchUntilStop(deps: Deps, simCandidates: readonly PoolEntry[], runCandidate: (entry: PoolEntry) => Promise<void>): Promise<boolean> {
	// Stop: candidates not yet dispatched when `signal` aborts never start;
	// sims already in flight run to the end.
	const signal = deps.signal;

	const dispatchedCandidates = signal?.aborted ? [] : simCandidates;
	const tasks = dispatchedCandidates.map(entry => () => runCandidate(entry));
	const concurrency = deps.concurrency ?? 1;
	let aborted = signal?.aborted ?? false;
	if (tasks.length > 0) {
		if (signal !== undefined) {
			// Checked as each task starts, so nothing in flight is torn down.
			await promisePool(
				tasks.map(task => async () => {
					if (signal.aborted) {
						aborted = true;
						return;
					}
					await task();
				}),
				concurrency,
			);
		} else {
			await promisePool(tasks, concurrency);
		}
	}
	return aborted;
}

/**
 * One candidate's best legal slot: a sim per slot `attemptEligibility` allows, after that
 * slot's gem repair, kept when it beats the slots before it. A slot whose hit read, repair
 * or sim fails goes to `candidateSkips`. `'stopped'` means Stop refused a hit read.
 */
async function bestSwapFor(loop: CandidateLoop, entry: PoolEntry): Promise<BestSwap | null | 'stopped'> {
	const { ctx, pool, baselineHitBudget, baselineDps, candidateSkips } = loop;
	const { input, deps, composeFor, iterations, simVersion, runOpts, equipment } = ctx;
	const slotNames = simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId);
	let best: BestSwap | null = null;

	for (let s = 0; s < slotNames.length; s++) {
		const slotName = slotNames[s]!;
		const eligibility = attemptEligibility(entry, slotName, equipment, pool.mainHandIsOneHanded);
		if (eligibility.kind === 'unmapped') {
			throw new Error(`slot mapping bug: ${entry.slot} -> ${slotName} is not in SIM_ORDER ` + `(item ${entry.itemId} ${entry.name})`);
		}
		if (eligibility.kind === 'skip') continue;
		const { slotIndex } = eligibility;
		let swapped: SimItemSpec[];
		let repairRecolors: readonly GemRecolor[];
		let removed: readonly { slotIndex: number; itemId: number }[];
		let repairGems: GemContext;
		try {
			repairGems = await candidateRepairGems(ctx, baselineHitBudget, slotIndex, entry.itemId, entry.randomSuffix);
		} catch (err) {
			// Stop refused the read: the row is left to the Stop placeholder.
			if (err instanceof StopRefusedSim) return 'stopped';
			if (!(err instanceof CandidateHitReadFailed)) throw err;
			// A slot that runs no sim leaves the candidates' sim count.
			loop.candidateSims.count -= 1;
			candidateSkips.push({
				kind: 'sim',
				itemId: entry.itemId,
				name: entry.name,
				slot: slotName,
				reason: err.message,
			});
			continue;
		}
		try {
			const outcome = candidateSwapWithRepairs(equipment, slotIndex, entry.itemId, repairGems, entry.randomSuffix);
			swapped = outcome.equipment;
			repairRecolors = outcome.recolors;
			removed = outcome.removed;
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			loop.candidateSims.count -= 1;
			candidateSkips.push({
				kind: 'repair',
				itemId: entry.itemId,
				name: entry.name,
				slot: slotName,
				reason: err.message,
			});
			continue;
		}
		const candReq = composeFor(swapped);
		const candOutcome = await simOrFailure(deps, candReq, simVersion, runOpts);
		if (!('simError' in candOutcome) && candOutcome.fromStore) loop.candidateSims.count -= 1;
		if ('simError' in candOutcome) {
			const err = candOutcome.simError;
			candidateSkips.push({
				kind: 'sim',
				itemId: entry.itemId,
				name: entry.name,
				slot: slotName,
				reason: err instanceof Error ? err.message : String(err),
			});
			continue;
		}
		const candObs = candOutcome.observation;
		const deltaDps = candObs.dps - baselineDps;
		const note = setBreakNote(equipment, slotIndex, entry.itemId);
		if (!best || deltaDps > best.deltaDps) {
			const next: BestSwap = {
				deltaDps,
				se: sampleOf(candObs, iterations).se,
				request: candReq,
				slotIndex,
				repairRecolors,
				removed,
				candidateGems: swapped[slotIndex]?.gems ?? [],
			};
			// Every weapon row names its hand: `"weapon"` alone cannot say
			// whether a non-dual-wield spec's row is a main-hand or an off-hand
			// item, and readers that fall back to the slot's first placement
			// would label a shield "Main Hand".
			if (slotNames.length > 1 || entry.slot === 'weapon') {
				next.slotChoice = slotName;
			}
			if (note) next.setBonusNote = note;
			best = next;
		}
	}
	return best;
}

/**
 * The row of a candidate the loop priced, from its best swap. `placeholderRow` writes the
 * same fields in another key order, and stored rankings keep both orders, so the two stay
 * apart.
 */
function rankedRow(entry: PoolEntry, best: BestSwap, worn: boolean, baselineDps: number, cutoff: Cutoff, gems: GemContext): RankedItem {
	const deltaPct = baselineDps === 0 ? 0 : (best.deltaDps / baselineDps) * 100;
	const belowCutoff = !meetsCutoff(best.deltaDps, cutoff);
	const item: RankedItem = {
		rank: null,
		itemId: entry.itemId,
		name: entry.name,
		slot: entry.slot,
		source: entry.source,
		deltaDps: best.deltaDps,
		deltaPct,
		se: best.se,
		seMethod: 'independent',
		bisTags: entry.bisTags ?? [],
		...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
		...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
		belowCutoff,
	};
	if (entry.randomSuffix) item.randomSuffix = entry.randomSuffix;
	if (entry.sources) item.sources = entry.sources;
	if (best.slotChoice) item.slotChoice = best.slotChoice;
	if (best.setBonusNote) item.setBonusNote = best.setBonusNote;
	if (best.repairRecolors.length > 0) {
		item.gemSubstitutions = best.repairRecolors.map(s => ({
			itemId: s.itemId,
			socketIndex: s.socketIndex,
			from: s.from,
			to: s.to,
		}));
	}
	if (best.removed.length > 0) {
		item.removedItems = best.removed.map(r => ({
			itemId: r.itemId,
			slot: SIM_ORDER[r.slotIndex] as SimSlotName,
		}));
	}
	if (worn) item.owned = true;
	if (metaSocketUnpriced(entry.itemId, best.candidateGems, gems.spec)) {
		item.emptyMetaSocket = true;
	}
	return item;
}

/** The row of a candidate Stop kept from running; see `rankedRow` for why it is separate. */
function placeholderRow(entry: PoolEntry, slotChoice: SimSlotName | undefined, worn: boolean): RankedItem {
	// A row Stop never reached: placeholder numbers keep it a RankedItem,
	// and `simmed: false` keeps the zeroed deltaDps out of cutoff
	// classification and tie groups.
	return {
		rank: null,
		itemId: entry.itemId,
		name: entry.name,
		slot: entry.slot,
		...(slotChoice ? { slotChoice } : {}),
		source: entry.source,
		deltaDps: 0,
		deltaPct: 0,
		se: 0,
		seMethod: 'independent',
		simmed: false,
		bisTags: entry.bisTags ?? [],
		...(entry.curatedSets ? { curatedSets: entry.curatedSets } : {}),
		...(entry.bisSets ? { bisSets: entry.bisSets } : {}),
		belowCutoff: false,
		...(entry.sources ? { sources: entry.sources } : {}),
		...(worn ? { owned: true } : {}),
		...(entry.randomSuffix ? { randomSuffix: entry.randomSuffix } : {}),
	};
}

/**
 * Which `(item, slot)` attempts may be priced. It returns why an attempt
 * may not, because an unmappable slot is a bug the loop throws on, while
 * a skipped attempt is simply not priced.
 */
function attemptEligibility(
	entry: PoolEntry,
	slotName: SimSlotName,
	equipment: readonly SimItemSpec[],
	mainHandIsOneHanded: boolean,
): { kind: 'ok'; slotIndex: number } | { kind: 'skip' } | { kind: 'unmapped' } {
	// A one-hander goes in the off hand only beside a one-handed main hand.
	// `simSlotsForPoolSlot` checks only the candidate's hand type, so without
	// this a one-hander would be simmed beside a worn two-hander, a pairing
	// the game cannot equip; displacing the two-hander would price a two-item
	// swap under a one-item row. `oneHandBlockedEntries` already holds these
	// out before ordering; this stays as a backstop.
	if (slotName === 'offhand' && !mainHandIsOneHanded) return { kind: 'skip' };
	const slotIndex = SIM_ORDER.indexOf(slotName);
	if (slotIndex < 0) return { kind: 'unmapped' };
	// A worn item is priced only in the slot it is worn in. A paired slot
	// keeps the better of its two placements, so a second placement would
	// turn the worn item's "you already wear this" row into "wear a second
	// copy": legal for a non-unique ring or trinket, but nothing in the row
	// would say so. `paneRows` in `model/results_view.ts` relies on this to
	// keep worn rows out of the below-cutoff group.
	const wornAt = equipment.findIndex(spec => spec.id === entry.itemId);
	if (wornAt >= 0 && wornAt !== slotIndex) return { kind: 'skip' };
	return { kind: 'ok', slotIndex };
}

/**
 * The slot a Stop placeholder names. A simmed weapon, ring or trinket row
 * names its best swap's slot; when only one placement passes
 * `attemptEligibility`, that slot is known without a sim, so the
 * placeholder names it too and files in the same pane. With two legal
 * placements only the sim could choose, so it stays unset.
 */
function placeholderSlotChoice(loop: CandidateLoop, entry: PoolEntry): SimSlotName | undefined {
	const slotNames = simSlotsForPoolSlot(entry.slot, loop.ctx.input.spec, entry.itemId);
	if (slotNames.length < 2 && entry.slot !== 'weapon') return undefined;
	const legal = legalSlotNames(loop, entry);
	return legal.length === 1 ? legal[0] : undefined;
}

/** The slots `attemptEligibility` lets a candidate be priced in: `bestSwapFor` runs one sim in each. */
function legalSlotNames(loop: CandidateLoop, entry: PoolEntry): SimSlotName[] {
	const { input, equipment } = loop.ctx;
	return simSlotsForPoolSlot(entry.slot, input.spec, entry.itemId).filter(
		slotName => attemptEligibility(entry, slotName, equipment, loop.pool.mainHandIsOneHanded).kind === 'ok',
	);
}
