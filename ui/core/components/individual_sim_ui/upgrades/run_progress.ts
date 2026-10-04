/**
 * What the Upgrades tab's progress component shows while a run is in flight
 * (ticket 542): the phase the engine is in, the bar's ratio, and an estimate
 * of the time left.
 *
 * The engine sends no phase of its own. The phase comes from the order its
 * `Progress` events arrive in (`rank.ts`): the pre-sim stages; the first
 * `simming` event (the baseline, `done` 1) and one per candidate; a set phase
 * that runs sims but sends nothing and is not counted in `total`; `ranking`;
 * then one `simming` event per replication sim. The only thing that tells the
 * last candidate from the start of the set phase is the candidate count, which
 * `replicationBoundary` solves from the first event's `total`.
 */

import type { Progress } from './engine/rank.js';
import { PAIRED_REPLICATE_TOP_N } from './engine/se.js';

/**
 * The tab passes no `seeds`, so `rank.ts` uses `defaultSeedsFor`, whose count
 * is the module-private `DEFAULT_SEED_COUNT`. This mirrors it rather than
 * editing the engine to export it. The guard is the block "run progress event
 * order (542)" in the repo's `fork-run-progress.test.ts`: it drives the real
 * engine with its default seeds on a seven- and a twelve-candidate pool and
 * checks the boundary and the replication count against the events the
 * engine sends. That block runs only where the fork is checked out; CI has no
 * fork and skips it.
 */
export const TAB_REPLICATE_SEED_COUNT = 5;

export type RunPhase = 'preparing' | 'candidates' | 'set-bonuses' | 'replication' | 'ranking';

export type EstimatorConfig = { kind: 'linear' } | { kind: 'phased'; kappa: number; psi: number; slowdown: number };

/**
 * The estimator and when to show it, all in one place so a change of
 * estimator touches only these values and `estimateRemainingMs`. Fitted on
 * one recorded feral run (run 1, 2026-10-03, fork 9b11bf214, 364 candidates,
 * concurrency 4), in sample: `.scratch/handoffs/542-run-progress/decision.md`
 * in the repo, section "Round 4". On that run later candidates took longer
 * while the sim server sat partly idle; the likely cause (hypothesis, render
 * time not measured) is the tab rebuilding every landed row twice per
 * finished candidate (`upgrades_tab.tsx`, `landedRowsTable`). So `slowdown`,
 * `kappa` and `psi` must be refitted if that rebuild changes.
 */
export const RUN_PROGRESS_ESTIMATOR: EstimatorConfig = { kind: 'phased', kappa: 0.3221, psi: 50.993, slowdown: 0.003064 };
export const RUN_PROGRESS_SHOW_FROM_FRACTION = 0.35;
export const RUN_PROGRESS_MIN_CANDIDATES_DONE = 10;

/**
 * The `done` of the last candidate's `simming` event: `1 + c`, for the
 * candidate count c with `total = 1 + c + (seedCount - 1)(1 + min(topN, c))`
 * (`rank.ts`, `totalSims`). `null` when no whole c gives `total`.
 */
export function replicationBoundary(total: number, seedCount: number, topN: number): number | null {
	if (seedCount <= 1) return total;
	const extra = seedCount - 1;
	// c <= topN: total = seedCount * (1 + c).
	const small = (total - seedCount) / seedCount;
	if (Number.isInteger(small) && small >= 0 && small <= topN) return 1 + small;
	// c > topN: total = 1 + c + extra * (1 + topN).
	const large = total - 1 - extra * (1 + topN);
	if (Number.isInteger(large) && large > topN) return 1 + large;
	return null;
}

/**
 * The Bulk dialog's elapsed text, so the two read the same
 * (`progress_tracker_modal.tsx`, `updateTimeDisplay`).
 */
export function formatElapsed(ms: number): string {
	const elapsed = ms / 1000;
	if (elapsed < 60) return `${elapsed.toFixed(1)}s`;
	return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`;
}

/** Everything a run has said so far, with times in ms since Run. */
export type RunTimeline = {
	/** Every `simming` event, in order. */
	readonly sims: ReadonlyArray<{ readonly t: number; readonly done: number; readonly afterRanking: boolean }>;
	/** The `ranking` event's time; undefined before it. */
	readonly rankingAt: number | undefined;
	readonly total: number;
	/** The last candidate's `done`; null when unknown or contradicted. */
	readonly boundary: number | null;
	/** Candidate sims in flight at once (`sim.concurrency`). */
	readonly concurrency: number;
	/** The time of the event the estimate is made at. */
	readonly now: number;
	/** Rows received before `ranking` that replication can re-sim. */
	readonly qualifyingRows: number;
	/** Seeds per re-simmed row (`TAB_REPLICATE_SEED_COUNT`). */
	readonly seedCount: number;
	/** The most rows replication re-sims (`PAIRED_REPLICATE_TOP_N`). */
	readonly topN: number;
};

/**
 * The `done` the run ends on. Replication re-sims only the rows that cleared
 * the cutoff, at most `topN`, with `seedCount - 1` sims each plus as many for
 * the baseline, and none at all when no row qualifies; `total` budgets for
 * `min(topN, c)` rows, so it is only an upper bound. Before the last
 * candidate, the qualifying rows so far are scaled up to the whole pool. A
 * replication event past the result means the count was wrong, and `total`
 * is used. `total` also when the boundary is unknown.
 */
export function expectedFinalDone(run: RunTimeline): number {
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
 * The time left, in ms, at the latest event of `run`; undefined when the run
 * has not said enough. Pure, so a different estimator replaces only this.
 *
 * Linear: the elapsed time per counted sim times the sims left.
 *
 * Phased: candidates run `concurrency` at a time, the set phase is uncounted,
 * and replication runs one sim at a time. With r the observed time per
 * candidate, psi is the set phase in candidate-times and each replication sim
 * costs k = kappa * concurrency candidate-times. Before the last candidate,
 * the i-th candidate is taken to cost a * (1 + slowdown * i), so the
 * candidates still to come cost more than the ones already done. The
 * replication sims counted are those `expectedFinalDone` expects, not the
 * whole budget in `total`.
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
	/** The last stage event's `stage`; the preparing label reads it. */
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
 * Follows one run's `Progress` events. The estimate is recomputed at
 * `simming` and `ranking` events, and at a row that adds to the qualifying
 * count (timed at the last `simming` event); it is held in between, as the
 * Bulk tab's is.
 */
export class RunProgressTracker {
	private readonly options: Required<TrackerOptions>;
	private phase: RunPhase = 'preparing';
	private stage: RunProgressView['stage'] = 'resolving';
	private total: number | undefined;
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
				this.phase =
					done === undefined || this.stopped || (timeline !== undefined && done >= expectedFinalDone(timeline)) ? 'ranking' : 'replication';
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
	 * false`, at most `PAIRED_REPLICATE_TOP_N`). In the repo's
	 * `fork-run-progress.test.ts`, test N1 checks the `simmed` clause on
	 * hand-built rows, and the block "run progress event order (542)" checks
	 * this count against the real engine's replication sims, including a pool
	 * with more qualifying rows than top-N. Both run only where the fork is
	 * checked out; CI has no fork and skips them.
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
		this.sims.push({ t: nowMs, done, afterRanking });
		if (afterRanking) {
			this.phase = this.stopped || done >= expectedFinalDone(this.timeline(nowMs)!) ? 'ranking' : 'replication';
			return;
		}
		// The seed-count mirror is wrong for this run: stop naming a set phase.
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
