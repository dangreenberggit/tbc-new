/**
 * What the progress dialog shows while a run is in flight. The engine does not say
 * what the run is doing, so the activity is read from the order of `Progress` events
 * (`rank.ts`, `rank-candidates.ts`, `rank-replication.ts`): setup stages, a `simming`
 * event for the baseline and each candidate, a set-bonus stage that sends nothing and
 * is not in `total`, `ranking`, then the replication sims.
 * Only the candidate count, which `doneAtLastCandidateFor` solves from the first
 * `total`, tells the last candidate from the set-bonus stage.
 */

import type { Progress } from './engine/rank';
import { DEFAULT_SEED_COUNT, isReplicable, PAIRED_REPLICATE_TOP_N } from './engine/se';

/** The tab passes no `seeds`, so the run uses the engine's default count. */
export const TAB_REPLICATE_SEED_COUNT = DEFAULT_SEED_COUNT;

export type RunActivity = 'preparing' | 'candidates' | 'set-bonuses' | 'replication' | 'ranking';

/**
 * Solved from `totalSims` in `rank-candidates.ts`:
 * `total = 1 + candidates + (seedCount - 1) * (1 + min(topN, candidates))`.
 * `null` when no whole candidate count fits.
 */
export function doneAtLastCandidateFor(total: number, seedCount: number, topN: number): number | null {
	if (seedCount <= 1) return total;
	const extra = seedCount - 1;
	// At most topN candidates: total = seedCount * (1 + candidates).
	const small = (total - seedCount) / seedCount;
	if (Number.isInteger(small) && small >= 0 && small <= topN) return 1 + small;
	// More than topN: total = 1 + candidates + extra * (1 + topN).
	const large = total - 1 - extra * (1 + topN);
	if (Number.isInteger(large) && large > topN) return 1 + large;
	return null;
}

export function formatElapsed(ms: number): string {
	const elapsed = ms / 1000;
	if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
	return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
}

/** Everything a run has said so far, with times in ms since Run. */
export type RunTimeline = {
	readonly sims: ReadonlyArray<{ readonly t: number; readonly done: number; readonly afterRanking: boolean }>;
	readonly rankingAt: number | undefined;
	readonly total: number;
	/** null when unknown or contradicted. */
	readonly doneAtLastCandidate: number | null;
	readonly concurrency: number;
	readonly now: number;
	/** Rows received before `ranking` that replication can re-sim. */
	readonly replicableRowCount: number;
	/** Seeds per re-simmed row (`TAB_REPLICATE_SEED_COUNT`). */
	readonly seedCount: number;
	/** The most rows replication re-sims (`PAIRED_REPLICATE_TOP_N`). */
	readonly topN: number;
	/** The exact total from the first `simming` event after `ranking`; undefined before it. */
	readonly finalTotal?: number;
	/** The share of each counted sim under way that is done, summed; 0 when none is. */
	readonly inFlight?: number;
	/** The sims the candidates run, from the engine's latest candidates event; undefined before it. */
	readonly candidateSims?: number;
	/** The candidates' sims that ended, each once; 0 when none has. */
	readonly candidateSimsEnded?: number;
	/**
	 * When the stage under way sent its first progress report: a sim's iterations or a
	 * counted step. Undefined before the candidates' first report, and from `ranking`
	 * until the re-sims' first one.
	 */
	readonly stageStartedAt?: number;
};

/**
 * The `done` the run ends on. The first `total` is only an upper bound, so until
 * `finalTotal` arrives this projects replication from the rows that cleared the
 * cutoff so far, scaled up to the whole pool. Falls back to `total` when the
 * projection is unknown or a later event passes it.
 */
export function expectedFinalDone(run: RunTimeline): number {
	if (run.finalTotal !== undefined) return run.finalTotal;
	const doneAtLastCandidate = run.doneAtLastCandidate;
	if (doneAtLastCandidate === null) return run.total;
	const c = doneAtLastCandidate - 1;
	const before = run.sims.filter(s => !s.afterRanking);
	const lastBefore = before[before.length - 1];
	const n = lastBefore ? Math.min(lastBefore.done - 1, c) : 0;
	const q = run.replicableRowCount;
	const projected = n >= c ? q : n > 0 ? (q * c) / n : 0;
	const rows = Math.min(run.topN, projected);
	const expected = doneAtLastCandidate + (rows === 0 ? 0 : (run.seedCount - 1) * (1 + rows));
	const after = run.sims.filter(s => s.afterRanking);
	const lastAfter = after[after.length - 1];
	return lastAfter && lastAfter.done > expected ? run.total : expected;
}

/**
 * The time left of the stage under way, in ms, by wowsims' Bulk rule: the time
 * since the stage started per step done, times the steps left in it
 * (`features/bulk/model/progress.ts:34`, `:51`, `:67`), with the clock restarted
 * at each stage's first progress report (`features/bulk/model/core_sim.ts:48-51`),
 * so the time spent sending the stage's sims out is not priced. The candidates'
 * steps are their sims, as in Bulk's sim stage (`progress.ts:60-66`). Later stages
 * are not priced, so near a stage's end the figure is close to 0 while the stage
 * name says what runs next; undefined until a step of the stage is done or under way.
 */
export function estimateRemainingMs(run: RunTimeline): number | undefined {
	const stage = stageUnderWay(run);
	if (!stage || run.stageStartedAt === undefined) return undefined;
	const elapsed = run.now - run.stageStartedAt;
	// At the first report no time has passed: Bulk's figure reads 0 there, which would say the stage is done.
	if (elapsed <= 0) return undefined;
	// The sims under way count by their iterations done, as the Bulk sim counts its own
	// (`features/bulk/model/progress.ts:60-65`), so the figure moves between landings.
	const done = stage.done + (run.inFlight ?? 0);
	if (done <= 0) return undefined;
	return Math.max(0, (elapsed / done) * (stage.size - done));
}

/**
 * The stage that counts sims and is under way, in the steps it is priced by: the
 * candidates' sims from the first `simming` event, which carries their number, or
 * the re-sims from `ranking`, once the engine has restated the total.
 */
function stageUnderWay(run: RunTimeline): { size: number; done: number } | undefined {
	const last = run.sims[run.sims.length - 1];
	if (!last) return undefined;
	if (run.rankingAt === undefined) {
		// At the last candidate the set-bonus stage begins, and it sends no count.
		if (run.doneAtLastCandidate === null || last.done >= run.doneAtLastCandidate) return undefined;
		// A ring, trinket or dual-wield weapon is one candidate of two sims run one after
		// the other. Counted in candidates, its first sim's credit would drop out when it
		// ends until the second one ends, which doubled the figure early in a run (ticket 900).
		if (run.candidateSims === undefined) return undefined;
		return { size: run.candidateSims, done: run.candidateSimsEnded ?? 0 };
	}
	const before = run.sims.filter(s => !s.afterRanking);
	const lastBefore = before[before.length - 1];
	if (run.finalTotal === undefined || !lastBefore) return undefined;
	return { size: run.finalTotal - lastBefore.done, done: last.done - lastBefore.done };
}

export type RunProgressView = {
	activity: RunActivity;
	/** The label shown while preparing reads it. */
	stage: Exclude<Progress, { kind: 'row' }>['stage'];
	done?: number;
	total?: number;
	doneAtLastCandidate: number | null;
	remainingMs?: number;
	concurrency: number;
	replicableRowCount: number;
};

type TrackerOptions = {
	seedCount?: number;
	topN?: number;
};

/**
 * The estimate is recomputed at `simming` and `ranking` events and at each
 * counted sim's iteration progress, as the Bulk tab's is at its sims' progress
 * (`features/bulk/model/core_sim.ts:42-59`), and held in between.
 */
export class RunProgressTracker {
	private readonly options: Required<TrackerOptions>;
	private activity: RunActivity = 'preparing';
	private stage: RunProgressView['stage'] = 'resolving';
	private total: number | undefined;
	private finalTotal: number | undefined;
	private doneAtLastCandidate: number | null = null;
	private readonly sims: Array<{ t: number; done: number; afterRanking: boolean }> = [];
	private rankingAt: number | undefined;
	private concurrency = 1;
	private replicableRowCount = 0;
	private stopped = false;
	private estimate: number | undefined;
	private readonly inFlight = new Map<string, number>();
	/** Sims that ended: the runner may say so twice, and a sim ends once. */
	private readonly endedSims = new Set<string>();
	private candidateSims: number | undefined;
	private candidateSimsEnded = 0;
	/** `RunTimeline.stageStartedAt`: set by a stage's first report, cleared at `ranking`. */
	private stageStartedAt: number | undefined;

	constructor(options: TrackerOptions = {}) {
		this.options = { seedCount: TAB_REPLICATE_SEED_COUNT, topN: PAIRED_REPLICATE_TOP_N, ...options };
	}

	setConcurrency(n: number): void {
		this.concurrency = n;
	}

	/** From a Stop on, the estimate is hidden and the final activity is `ranking`. */
	noteStop(): void {
		this.stopped = true;
	}

	observe(p: Progress, nowMs: number): void {
		if ('kind' in p) {
			this.observeRow(p.row);
			return;
		}
		this.stage = p.stage;
		switch (p.stage) {
			case 'resolving':
			case 'reading-gear':
			case 'composing':
			case 'building-pool':
				this.activity = 'preparing';
				return;
			case 'simming':
				this.observeSimming(p.done, p.total, p.candidateSims, nowMs);
				break;
			case 'ranking': {
				this.rankingAt = nowMs;
				this.stageStartedAt = undefined;
				const done = this.lastDone();
				const timeline = this.timeline(nowMs);
				this.activity =
					done === undefined || this.stopped || (timeline !== undefined && done >= expectedFinalDone(timeline)) ? 'ranking' : 'replication';
				break;
			}
		}
		this.recompute(nowMs);
	}

	/**
	 * One sim's iterations done, from the runner. Only the stages that count sims
	 * count them. A candidate's sim that ends counts as one done, as Bulk's sim stage
	 * counts a finished sim (`features/bulk/model/progress.ts:60-66`); a re-sim is a
	 * step of its own, which the `simming` event after it counts. A sim that ends
	 * leaves the count without a recompute, so the figure holds until the next report
	 * or event; a recompute at a stage's last sim would read "0s" for a moment.
	 */
	observeIterations(simId: string, completed: number, total: number, nowMs: number): void {
		if ((this.activity !== 'candidates' && this.activity !== 'replication') || total <= 0) return;
		if (this.endedSims.has(simId)) return;
		this.stageStartedAt ??= nowMs;
		if (completed >= total) {
			this.endedSims.add(simId);
			this.inFlight.delete(simId);
			if (this.activity === 'candidates') this.candidateSimsEnded += 1;
			return;
		}
		this.inFlight.set(simId, completed / total);
		this.recompute(nowMs);
	}

	view(): RunProgressView {
		return {
			activity: this.activity,
			stage: this.stage,
			...(this.total === undefined ? {} : { done: this.lastDone(), total: this.total }),
			doneAtLastCandidate: this.doneAtLastCandidate,
			...(!this.stopped && this.estimate !== undefined ? { remainingMs: this.estimate } : {}),
			concurrency: this.concurrency,
			replicableRowCount: this.replicableRowCount,
		};
	}

	private observeRow(row: { readonly belowCutoff: boolean; readonly simmed?: false }): void {
		if (this.rankingAt !== undefined || !isReplicable(row)) return;
		this.replicableRowCount += 1;
	}

	private observeSimming(done: number, total: number, candidateSims: number | undefined, nowMs: number): void {
		const afterRanking = this.rankingAt !== undefined;
		if (!afterRanking && candidateSims !== undefined) this.candidateSims = candidateSims;
		// The first event names the candidates and the first after `ranking` restates the total: neither is a step.
		const namesStage = this.total === undefined || (afterRanking && this.finalTotal === undefined);
		if (!namesStage) this.stageStartedAt ??= nowMs;
		if (this.total === undefined) {
			this.doneAtLastCandidate = doneAtLastCandidateFor(total, this.options.seedCount, this.options.topN);
		}
		this.total = total;
		if (afterRanking && this.finalTotal === undefined) this.finalTotal = total;
		this.sims.push({ t: nowMs, done, afterRanking });
		if (afterRanking) {
			this.activity = this.stopped || done >= expectedFinalDone(this.timeline(nowMs)!) ? 'ranking' : 'replication';
			return;
		}
		// The seed count does not match this run, so the set-bonus stage cannot be told apart.
		if (this.doneAtLastCandidate !== null && done > this.doneAtLastCandidate) this.doneAtLastCandidate = null;
		this.activity = this.doneAtLastCandidate !== null && done === this.doneAtLastCandidate ? 'set-bonuses' : 'candidates';
	}

	private lastDone(): number | undefined {
		return this.sims[this.sims.length - 1]?.done;
	}

	private timeline(nowMs: number): RunTimeline | undefined {
		if (this.total === undefined) return undefined;
		return {
			sims: this.sims,
			rankingAt: this.rankingAt,
			total: this.total,
			doneAtLastCandidate: this.doneAtLastCandidate,
			concurrency: this.concurrency,
			now: nowMs,
			replicableRowCount: this.replicableRowCount,
			seedCount: this.options.seedCount,
			topN: this.options.topN,
			...(this.finalTotal === undefined ? {} : { finalTotal: this.finalTotal }),
			inFlight: [...this.inFlight.values()].reduce((sum, share) => sum + share, 0),
			...(this.candidateSims === undefined ? {} : { candidateSims: this.candidateSims }),
			candidateSimsEnded: this.candidateSimsEnded,
			...(this.stageStartedAt === undefined ? {} : { stageStartedAt: this.stageStartedAt }),
		};
	}

	private recompute(nowMs: number): void {
		const done = this.lastDone();
		const timeline = this.timeline(nowMs);
		if (done === undefined || timeline === undefined) return;
		this.estimate = estimateRemainingMs(timeline);
	}
}
