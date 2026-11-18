/**
 * What the progress dialog shows while a run is in flight. The engine sends no
 * phase, so it is read from the order of `Progress` events (`rank.ts`): setup
 * stages, a `simming` event for the baseline and each candidate, a set-bonus stage
 * that sends nothing and is not in `total`, `ranking`, then the replication sims.
 * Only the candidate count, which `replicationBoundary` solves from the first
 * `total`, tells the last candidate from the set-bonus stage.
 */

import type { Progress } from './engine/rank';
import { PAIRED_REPLICATE_TOP_N } from './engine/se';

/**
 * The tab passes no `seeds`, so `rank.ts` uses `defaultSeedsFor`, whose count is
 * the module-private `DEFAULT_SEED_COUNT`. Keep the two equal.
 */
export const TAB_REPLICATE_SEED_COUNT = 5;

export type RunPhase = 'preparing' | 'candidates' | 'set-bonuses' | 'replication' | 'ranking';

export type EstimatorConfig = { kind: 'linear' } | { kind: 'phased'; kappa: number; psi: number; slowdown: number };

/**
 * Fitted on one recorded feral run (364 candidates, concurrency 4). Later
 * candidates slowed there, likely from rendering each new row, so refit
 * `slowdown`, `kappa` and `psi` when that cost changes.
 */
export const RUN_PROGRESS_ESTIMATOR: EstimatorConfig = { kind: 'phased', kappa: 0.3221, psi: 50.993, slowdown: 0.003064 };
export const RUN_PROGRESS_SHOW_FROM_FRACTION = 0.35;
export const RUN_PROGRESS_MIN_CANDIDATES_DONE = 10;

/**
 * The `done` of the last candidate, solved from `totalSims` in `rank.ts`:
 * `total = 1 + candidates + (seedCount - 1) * (1 + min(topN, candidates))`.
 * `null` when no whole candidate count fits.
 */
export function replicationBoundary(total: number, seedCount: number, topN: number): number | null {
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
	/** The last candidate's `done`; null when unknown or contradicted. */
	readonly boundary: number | null;
	readonly concurrency: number;
	readonly now: number;
	/** Rows received before `ranking` that replication can re-sim. */
	readonly qualifyingRows: number;
	/** Seeds per re-simmed row (`TAB_REPLICATE_SEED_COUNT`). */
	readonly seedCount: number;
	/** The most rows replication re-sims (`PAIRED_REPLICATE_TOP_N`). */
	readonly topN: number;
	/** The exact total from the first `simming` event after `ranking`; undefined before it. */
	readonly finalTotal?: number;
};

/**
 * The `done` the run ends on. The first `total` is only an upper bound, so until
 * `finalTotal` arrives this projects replication from the rows that cleared the
 * cutoff so far, scaled up to the whole pool. Falls back to `total` when the
 * projection is unknown or a later event passes it.
 */
export function expectedFinalDone(run: RunTimeline): number {
	if (run.finalTotal !== undefined) return run.finalTotal;
	const boundary = run.boundary;
	if (boundary === null) return run.total;
	const c = boundary - 1;
	const before = run.sims.filter(s => !s.afterRanking);
	const lastBefore = before[before.length - 1];
	const n = lastBefore ? Math.min(lastBefore.done - 1, c) : 0;
	const q = run.qualifyingRows;
	const projected = n >= c ? q : n > 0 ? (q * c) / n : 0;
	const rows = Math.min(run.topN, projected);
	const expected = boundary + (rows === 0 ? 0 : (run.seedCount - 1) * (1 + rows));
	const after = run.sims.filter(s => s.afterRanking);
	const lastAfter = after[after.length - 1];
	return lastAfter && lastAfter.done > expected ? run.total : expected;
}

/**
 * The time left, in ms; undefined until the run has said enough. `linear` scales
 * the time per sim so far. `phased` assumes candidates run `concurrency` at a
 * time, each a little slower than the last (`slowdown`); the set-bonus stage takes
 * `psi` candidates' time; each replication sim runs alone and takes
 * `kappa * concurrency`.
 */
export function estimateRemainingMs(config: EstimatorConfig, run: RunTimeline): number | undefined {
	const first = run.sims[0];
	const last = run.sims[run.sims.length - 1];
	if (!first || !last) return undefined;
	const t1 = first.t;
	const total = run.total;
	const atRanking = run.rankingAt !== undefined;
	const done = last.done;

	const linear = (): number | undefined => (done > 1 ? ((run.now - t1) / (done - 1)) * (total - done) : undefined);

	let estimate: number | undefined;
	if (config.kind === 'linear') {
		estimate = linear();
	} else {
		const k = config.kappa * run.concurrency;
		const boundary = run.boundary;
		const finalDone = expectedFinalDone(run);
		const boundaryEvent = boundary === null ? undefined : run.sims.find(s => !s.afterRanking && s.done === boundary);
		if (!atRanking) {
			if (boundary === null) {
				estimate = linear();
			} else {
				const left = finalDone - boundary;
				if (done < boundary) {
					const n = done - 1;
					const c = boundary - 1;
					if (n >= 1) {
						const tau = run.now - t1;
						const beta = config.slowdown;
						const tri = (x: number) => (x * (x + 1)) / 2;
						const a = tau / (n + beta * tri(n));
						const candidatesLeft = a * (c - n + beta * (tri(c) - tri(n)));
						const meanPerCandidate = (tau + candidatesLeft) / c;
						estimate = candidatesLeft + meanPerCandidate * (config.psi + k * left);
					}
				} else if (boundaryEvent && boundary > 1) {
					estimate = ((boundaryEvent.t - t1) / (boundary - 1)) * (config.psi + k * left);
				}
			}
		} else {
			const beforeRanking = run.sims.filter(s => !s.afterRanking);
			const lastBefore = beforeRanking[beforeRanking.length - 1];
			const b = lastBefore?.done;
			let rB: number | undefined;
			if (boundaryEvent && boundary !== null && boundary > 1) {
				rB = (boundaryEvent.t - t1) / (boundary - 1);
			} else if (lastBefore && b !== undefined && b > 1) {
				rB = (lastBefore.t - t1) / (b - 1);
			}
			const m = b === undefined ? 0 : done - b;
			if (m >= 2) {
				estimate = ((run.now - run.rankingAt!) / m) * (finalDone - done);
			} else if (rB !== undefined) {
				estimate = rB * k * (finalDone - done);
			}
		}
	}
	return estimate === undefined ? undefined : Math.max(0, estimate);
}

export type RunProgressView = {
	phase: RunPhase;
	/** The label shown while preparing reads it. */
	stage: Exclude<Progress, { kind: 'row' }>['stage'];
	done?: number;
	total?: number;
	boundary: number | null;
	remainingMs?: number;
	concurrency: number;
	qualifyingRows: number;
};

type TrackerOptions = {
	estimator: EstimatorConfig;
	showFromFraction: number;
	minCandidatesDone: number;
	seedCount?: number;
	topN?: number;
};

/**
 * The estimate is recomputed at `simming` and `ranking` events and at a row that
 * replication can re-sim, and held in between, as the Bulk tab's is.
 */
export class RunProgressTracker {
	private readonly options: Required<TrackerOptions>;
	private phase: RunPhase = 'preparing';
	private stage: RunProgressView['stage'] = 'resolving';
	private total: number | undefined;
	private finalTotal: number | undefined;
	private boundary: number | null = null;
	private readonly sims: Array<{ t: number; done: number; afterRanking: boolean }> = [];
	private rankingAt: number | undefined;
	private concurrency = 1;
	private qualifyingRows = 0;
	private stopped = false;
	private shown = false;
	private estimate: number | undefined;

	constructor(options: TrackerOptions) {
		this.options = { seedCount: TAB_REPLICATE_SEED_COUNT, topN: PAIRED_REPLICATE_TOP_N, ...options };
	}

	setConcurrency(n: number): void {
		this.concurrency = n;
	}

	/** From a Stop on, the estimate is hidden and the final phase is `ranking`. */
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
				this.phase = 'preparing';
				return;
			case 'simming':
				this.observeSimming(p.done, p.total, nowMs);
				break;
			case 'ranking': {
				this.rankingAt = nowMs;
				const done = this.lastDone();
				const timeline = this.timeline(nowMs);
				this.phase = done === undefined || this.stopped || (timeline !== undefined && done >= expectedFinalDone(timeline)) ? 'ranking' : 'replication';
				break;
			}
		}
		this.recompute(nowMs);
	}

	view(): RunProgressView {
		return {
			phase: this.phase,
			stage: this.stage,
			...(this.total === undefined ? {} : { done: this.lastDone(), total: this.total }),
			boundary: this.boundary,
			...(this.shown && !this.stopped && this.estimate !== undefined ? { remainingMs: this.estimate } : {}),
			concurrency: this.concurrency,
			qualifyingRows: this.qualifyingRows,
		};
	}

	/**
	 * Mirrors rank.ts `replicateTopItems`' filter (`!belowCutoff && simmed !==
	 * false`, at most `PAIRED_REPLICATE_TOP_N`); keep the two in step.
	 */
	private observeRow(row: { readonly belowCutoff: boolean; readonly simmed?: false }): void {
		if (this.rankingAt !== undefined || row.belowCutoff !== false || row.simmed === false) return;
		this.qualifyingRows += 1;
		const last = this.sims[this.sims.length - 1];
		if (last) this.recompute(last.t);
	}

	private observeSimming(done: number, total: number, nowMs: number): void {
		if (this.total === undefined) {
			this.boundary = replicationBoundary(total, this.options.seedCount, this.options.topN);
		}
		this.total = total;
		const afterRanking = this.rankingAt !== undefined;
		if (afterRanking && this.finalTotal === undefined) this.finalTotal = total;
		this.sims.push({ t: nowMs, done, afterRanking });
		if (afterRanking) {
			this.phase = this.stopped || done >= expectedFinalDone(this.timeline(nowMs)!) ? 'ranking' : 'replication';
			return;
		}
		// The seed count does not match this run, so the set-bonus stage cannot be told apart.
		if (this.boundary !== null && done > this.boundary) this.boundary = null;
		this.phase = this.boundary !== null && done === this.boundary ? 'set-bonuses' : 'candidates';
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
			boundary: this.boundary,
			concurrency: this.concurrency,
			now: nowMs,
			qualifyingRows: this.qualifyingRows,
			seedCount: this.options.seedCount,
			topN: this.options.topN,
			...(this.finalTotal === undefined ? {} : { finalTotal: this.finalTotal }),
		};
	}

	private recompute(nowMs: number): void {
		const done = this.lastDone();
		const timeline = this.timeline(nowMs);
		if (done === undefined || timeline === undefined) return;
		this.estimate = estimateRemainingMs(this.options.estimator, timeline);
		if (!this.shown && done - 1 >= this.options.minCandidatesDone && done / timeline.total >= this.options.showFromFraction) {
			this.shown = true;
		}
	}
}
