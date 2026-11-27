/**
 * The run progress tracker, driven with hand-built event lists.
 *
 * `run_progress.ts` turns the engine's `Progress` events into the activity the
 * progress component names, the bar's ratio and a remaining-time estimate.
 * Every expected value is worked out by hand in the comment beside it. The
 * same tracker against the events the real engine sends is in
 * `rank_progress_events.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import type { Progress, RankedItem } from './engine/rank';
import { doneAtLastCandidateFor, estimateRemainingMs, expectedFinalDone, formatElapsed, RunProgressTracker, type RunTimeline } from './run_progress';

/** A `simming` event; a candidates' event also says how many sims the candidates run. */
const sim = (done: number, total: number, candidateSims?: number): Progress => ({
	stage: 'simming',
	done,
	total,
	...(candidateSims === undefined ? {} : { candidateSims }),
});
const RANKING: Progress = { stage: 'ranking' };
/** A sim's first report, with no iterations done yet: it starts the stage's clock. */
const startClock = (t: RunProgressTracker, nowMs: number) => t.observeIterations('clock', 0, 1_000, nowMs);
/** Sims that end, each counted as one done, as the runner reports a sim's end. */
const endSims = (t: RunProgressTracker, ids: readonly string[], nowMs: number) => {
	for (const id of ids) t.observeIterations(id, 1_000, 1_000, nowMs);
};
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
/** A landed row; the tracker reads only whether it clears the cutoff and whether Stop left it unsimmed. */
const row = (belowCutoff: boolean, simmed?: false): Progress => ({
	kind: 'row',
	row: { belowCutoff, ...(simmed === undefined ? {} : { simmed }) } as RankedItem,
});

describe('run progress tracker, pure', () => {
	const tracker = (concurrency = 1): RunProgressTracker => {
		const t = new RunProgressTracker();
		t.setConcurrency(concurrency);
		return t;
	};

	describe("formatElapsed matches the Bulk dialog's elapsed text", () => {
		it.each([
			[0, '0.0s'],
			[7_340, '7.3s'],
			// Upstream rounds with toFixed(1) before it switches to minutes.
			[59_990, '60.0s'],
			[60_000, '1m 0s'],
			[435_000, '7m 15s'],
		])('%i ms reads %s', (ms, text) => {
			expect(formatElapsed(ms)).toBe(text);
		});
	});

	describe('doneAtLastCandidateFor', () => {
		// total = 1 + c + 4 * (1 + min(8, c)) with five seeds and top-N 8,
		// written out by hand for each c.
		it.each([
			[5, 1], // c = 0: 1 + 0 + 4 * 1
			[10, 2], // c = 1: 1 + 1 + 4 * 2
			[30, 6], // c = 5: 1 + 5 + 4 * 6
			[40, 8], // c = 7: 1 + 7 + 4 * 8
			[45, 9], // c = 8: 1 + 8 + 4 * 9
			[46, 10], // c = 9: 1 + 9 + 4 * 9
			[277, 241], // c = 240: 1 + 240 + 36
			[401, 365], // c = 364: run 1's total and boundary
		])('total %i gives boundary %i', (total, boundary) => {
			expect(doneAtLastCandidateFor(total, 5, 8)).toBe(boundary);
		});

		it('returns the total itself with a single seed', () => {
			expect(doneAtLastCandidateFor(57, 1, 8)).toBe(57);
		});

		it.each([7, 38])('returns null for total %i, which no c gives', total => {
			expect(doneAtLastCandidateFor(total, 5, 8)).toBeNull();
		});
	});

	describe("activities follow the engine's event order", () => {
		// T = 57 is c = 20 candidates: 1 + 20 + 4 * 9, so B = 21.
		it('names each pre-sim stage as preparing', () => {
			const t = tracker();
			expect(t.view().activity).toBe('preparing');
			for (const stage of ['resolving', 'reading-gear', 'composing', 'building-pool'] as const) {
				t.observe({ stage }, 10);
				expect(t.view()).toMatchObject({ activity: 'preparing', stage });
			}
			expect(t.view().done).toBeUndefined();
			expect(t.view().doneAtLastCandidate).toBeNull();
		});

		it('walks candidates, set bonuses, replication and ranking', () => {
			const t = tracker();
			t.observe({ stage: 'building-pool' }, 0);
			t.observe(sim(1, 57), 100);
			expect(t.view()).toMatchObject({
				activity: 'candidates',
				done: 1,
				total: 57,
				doneAtLastCandidate: 21,
			});
			t.observe(sim(20, 57), 200);
			expect(t.view().activity).toBe('candidates');
			// Eight rows clear the cutoff, so all 36 replication sims are expected.
			for (let i = 0; i < 8; i++) t.observe(row(false), 210);
			expect(t.view()).toMatchObject({ activity: 'candidates', done: 20 });
			t.observe(sim(21, 57), 300);
			expect(t.view()).toMatchObject({ activity: 'set-bonuses', done: 21 });
			t.observe(RANKING, 400);
			expect(t.view()).toMatchObject({
				activity: 'replication',
				stage: 'ranking',
				done: 21,
			});
			// The engine restates the total: eight rows re-simmed, 21 + 4 * 9 = 57.
			t.observe(sim(21, 57), 450);
			expect(t.view()).toMatchObject({
				activity: 'replication',
				done: 21,
				total: 57,
			});
			t.observe(sim(40, 57), 500);
			expect(t.view().activity).toBe('replication');
			t.observe(sim(57, 57), 600);
			expect(t.view()).toMatchObject({ activity: 'ranking', done: 57 });
		});

		it('names a ranking with no sim count, a cached ranking, ranking', () => {
			const t = tracker();
			t.observe({ stage: 'resolving' }, 0);
			t.observe(RANKING, 50);
			expect(t.view()).toMatchObject({ activity: 'ranking', stage: 'ranking' });
			expect(t.view().done).toBeUndefined();
		});

		it('names the ranking after a Stop ranking, not replication', () => {
			const t = tracker();
			t.observe(sim(1, 57), 100);
			t.observe(sim(8, 57), 200);
			t.noteStop();
			t.observe(sim(9, 57), 300);
			expect(t.view().activity).toBe('candidates');
			t.observe(RANKING, 400);
			expect(t.view()).toMatchObject({ activity: 'ranking', done: 9 });
		});

		it('drops the boundary when a candidate count passes it', () => {
			const t = tracker();
			t.observe(sim(1, 57), 100);
			t.observe(sim(22, 57), 200);
			expect(t.view()).toMatchObject({
				activity: 'candidates',
				doneAtLastCandidate: null,
			});
			// The boundary stays dropped, so done == 21 is not the set phase.
			t.observe(sim(21, 57), 250);
			expect(t.view()).toMatchObject({
				activity: 'candidates',
				doneAtLastCandidate: null,
			});
			t.observe(RANKING, 300);
			expect(t.view().activity).toBe('replication');
		});
	});

	describe("the stage's clock, from its first progress report", () => {
		// The Bulk sim restarts its clock at the first progress report of a new
		// stage (`features/bulk/model/core_sim.ts:48-51`), not when the stage is
		// named, so the time spent sending the stage's sims out is not priced.
		it("starts the candidates' clock at their first report, with no figure at it", () => {
			const t = tracker(4);
			// 20 candidates of one slot each run 20 sims.
			t.observe(sim(1, 57, 20), 1_000);
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 0, 1_000, 1_500);
			// No time has passed on the stage's clock, so no figure, not "0s".
			expect(t.view().remainingMs).toBeUndefined();
			// Four sims a quarter done 500 ms in: one sim's worth, 500 / 1 * (20 - 1)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 250, 1_000, 2_000);
			expect(t.view().remainingMs).toBe(9_500);
		});

		it("starts the re-sims' clock at their first report, not at the ranking event", () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 8; i++) t.observe(row(false), 1_500);
			t.observe(sim(21, 57), 3_000);
			t.observe(RANKING, 5_000);
			t.observe(sim(21, 57), 5_000);
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 0, 500, 5_400);
			expect(t.view().remainingMs).toBeUndefined();
			// Four re-sims half done 2 s after their first report: two re-sims'
			// worth, 34 left: 2000 / 2 * (36 - 2)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 250, 500, 7_400);
			expect(t.view().remainingMs).toBe(34_000);
		});

		it('starts the clock at a counted step when no sim reported before it', () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			// The store answered the first candidate's sim: it lands with no
			// report, and the candidates have 19 sims left to run.
			t.observe(sim(2, 57, 19), 1_100);
			expect(t.view().remainingMs).toBeUndefined();
			// Four sims half done at 2100 ms, two sims' worth since the clock
			// started at 1100 ms: 1000 / 2 * (19 - 2)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 500, 1_000, 2_100);
			expect(t.view().remainingMs).toBe(8_500);
		});
	});

	describe('the time left of the stage under way', () => {
		// T = 57 is c = 20 candidates: 1 + 20 + 4 * 9, so B = 21. Each test's
		// first report starts the stage's clock (the describe above).
		it('prices the candidates left at the pace of the candidates so far, and no later stage', () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			startClock(t, 1_000);
			for (let i = 0; i < 8; i++) t.observe(row(false), 1_500);
			// 10 sims done at 2000 ms: (2000 - 1000) / 10 * (20 - 10)
			endSims(t, ids('s', 10), 2_000);
			t.observe(sim(11, 57, 20), 2_000);
			expect(t.view().remainingMs).toBe(1_000);
		});

		it('prices the re-sims left at the pace of the re-sims so far, from their first report', () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 8; i++) t.observe(row(false), 1_500);
			t.observe(sim(21, 57), 3_000);
			t.observe(RANKING, 5_000);
			// The engine restates the total: eight rows re-simmed, 21 + 4 * 9 = 57,
			// so the stage holds 36 re-sims.
			t.observe(sim(21, 57), 5_000);
			startClock(t, 5_000);
			// m = 4 at 5800 ms: (5800 - 5000) / 4 * (36 - 4)
			t.observe(sim(25, 57), 5_800);
			expect(t.view().remainingMs).toBe(6_400);
		});

		it('gives no time left in the set stage, which sends no count, nor before a re-sim is done', () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			startClock(t, 1_000);
			for (let i = 0; i < 8; i++) t.observe(row(false), 1_500);
			endSims(t, ids('s', 10), 2_000);
			t.observe(sim(11, 57, 20), 2_000);
			expect(t.view().remainingMs).toBeDefined();
			t.observe(sim(21, 57), 3_000);
			expect(t.view().activity).toBe('set-bonuses');
			expect(t.view().remainingMs).toBeUndefined();
			// A row that lands in the silent set stage recomputes nothing.
			t.observe(row(false), 4_000);
			expect(t.view().remainingMs).toBeUndefined();
			t.observe(RANKING, 5_000);
			expect(t.view().remainingMs).toBeUndefined();
			t.observe(sim(21, 57), 5_000);
			expect(t.view().remainingMs).toBeUndefined();
		});

		it('shows the time left from the first candidate done, as the Bulk sim does from its first step', () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			startClock(t, 1_000);
			expect(t.view().remainingMs).toBeUndefined();
			// 1 sim done at 1100 ms: 100 / 1 * (20 - 1)
			endSims(t, ['a'], 1_100);
			t.observe(sim(2, 57, 20), 1_100);
			expect(t.view().remainingMs).toBe(1_900);
		});

		it('counts the candidates under way by their iterations done, so the figure moves between landings', () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			startClock(t, 1_000);
			// Four sims a quarter done at 1500 ms: one sim's worth in 500 ms,
			// 19 left: 500 / 1 * (20 - 1)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 250, 1_000, 1_500);
			expect(t.view().remainingMs).toBe(9_500);
			// Half done at 2000 ms: two sims' worth, 1000 / 2 * (20 - 2)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 500, 1_000, 2_000);
			expect(t.view().remainingMs).toBe(9_000);
			// "a" ends and its candidate lands: 1 done plus three halves,
			// (2400 - 1000) / 2.5 * (20 - 2.5)
			t.observeIterations('a', 1_000, 1_000, 2_400);
			t.observe(sim(2, 57, 20), 2_400);
			expect(t.view().remainingMs).toBeCloseTo(9_800, 6);
		});

		it('counts the re-sims under way by their iterations, and no set-stage sim', () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 8; i++) t.observe(row(false), 1_500);
			t.observe(sim(21, 57), 3_000);
			// A set-stage sim's iterations give that stage no time left, and do not
			// count toward the re-sims after it.
			t.observeIterations('set', 500, 1_000, 4_000);
			expect(t.view().remainingMs).toBeUndefined();
			t.observe(RANKING, 5_000);
			t.observe(sim(21, 57), 5_000);
			startClock(t, 5_000);
			// Four re-sims half done 2 s in: two re-sims' worth, 34 left:
			// 2000 / 2 * (36 - 2)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 250, 500, 7_000);
			expect(t.view().remainingMs).toBe(34_000);
		});
	});

	describe("each stage's own count", () => {
		it("gives no time left once a candidate count passes the boundary, since the stage's size is then unknown", () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 20), 1_000);
			startClock(t, 1_000);
			endSims(t, ids('s', 10), 2_000);
			t.observe(sim(11, 57, 20), 2_000);
			expect(t.view().remainingMs).toBeDefined();
			// done 22 > B 21 drops the boundary.
			t.observe(sim(22, 57, 20), 3_100);
			expect(t.view()).toMatchObject({ doneAtLastCandidate: null });
			expect(t.view().remainingMs).toBeUndefined();
		});

		it("prices only the candidates left at half a steady run's candidates", () => {
			// 100 candidates of one sim at 250 ms each: T = 1 + 100 + 4 * 9 = 137,
			// B = 101. At 50 sims done: 250 * (100 - 50). No set stage or re-sim
			// is priced.
			const steady = Array.from({ length: 51 }, (_, i) => ({
				t: 250 * i,
				done: i + 1,
				afterRanking: false,
			}));
			expect(
				estimateRemainingMs({
					sims: steady,
					rankingAt: undefined,
					total: 137,
					doneAtLastCandidate: 101,
					concurrency: 4,
					now: 12_500,
					replicableRowCount: 8,
					seedCount: 5,
					topN: 8,
					stageStartedAt: 0,
					candidateSims: 100,
					candidateSimsEnded: 50,
				}),
			).toBeCloseTo(12_500, 6);
		});
	});

	describe('the candidates, counted in sims', () => {
		// Bulk's sim stage counts sims, the finished ones whole and the rest by
		// their iterations (`features/bulk/model/progress.ts:60-66`). T = 57 is
		// 20 candidates; 6 of them take two slots (a ring, a trinket), so the
		// candidates run 26 sims.
		it("keeps a finished sim's credit while its candidate's second slot runs, so the figure does not jump", () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 26), 1_000);
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 0, 1_000, 1_000);
			// Four sims 95% done 7 s in: 3.8 sims, 7000 / 3.8 * (26 - 3.8)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 950, 1_000, 8_000);
			const before = t.view().remainingMs!;
			expect(before).toBeCloseTo((7_000 / 3.8) * 22.2, 6);
			// "a" and "b" end and their candidates land. "c" and "d" were the
			// first slots of two-slot candidates, whose second slots start.
			t.observeIterations('a', 1_000, 1_000, 8_100);
			t.observe(sim(2, 57, 26), 8_100);
			t.observeIterations('b', 1_000, 1_000, 8_100);
			t.observe(sim(3, 57, 26), 8_100);
			t.observeIterations('c', 1_000, 1_000, 8_100);
			t.observeIterations('d', 1_000, 1_000, 8_100);
			for (const id of ['c2', 'd2', 'e', 'f']) t.observeIterations(id, 0, 1_000, 8_100);
			// Four sims done: 7100 / 4 * (26 - 4). Counted in candidates, the
			// figure would rise from 7000 / 3.8 * 16.2 at 8 s to 7100 / 2 * 18,
			// over twice as high.
			expect(t.view().remainingMs).toBeCloseTo((7_100 / 4) * 22, 6);
			expect(t.view().remainingMs!).toBeLessThan(before);
		});

		it("takes the sims the store answered out of the candidates' sims when their candidate lands", () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 26), 1_000);
			startClock(t, 1_000);
			// A two-slot candidate the store answered lands at once and runs no sim.
			t.observe(sim(2, 57, 24), 1_000);
			// Four sims half done 1 s in: 1000 / 2 * (24 - 2)
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 500, 1_000, 2_000);
			expect(t.view().remainingMs).toBe(11_000);
		});

		it("counts a sim's end once, though the runner may report it twice", () => {
			const t = tracker(4);
			t.observe(sim(1, 57, 26), 1_000);
			for (const id of ['a', 'b', 'c', 'd']) t.observeIterations(id, 0, 1_000, 1_000);
			// The worker's last report and the runner's own both say "a" ended.
			t.observeIterations('a', 1_000, 1_000, 2_000);
			t.observeIterations('a', 1_000, 1_000, 2_000);
			for (const id of ['b', 'c', 'd']) t.observeIterations(id, 500, 1_000, 2_000);
			// 1 done plus three halves: 1000 / 2.5 * (26 - 2.5)
			expect(t.view().remainingMs).toBeCloseTo(9_400, 6);
		});
	});

	describe('replication count from rows that clear the cutoff', () => {
		// T = 57 is c = 20, so B = 21. Five seeds and top-N 8: each re-simmed row
		// and the baseline take 4 sims, so R = 4 * (1 + min(8, Q)), or 0 when Q = 0.

		it('expects no replication when no row qualifies', () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 9; i++) t.observe(row(true), 1_500);
			// A row Stop left unsimmed is never re-simmed.
			t.observe(row(false, false), 1_500);
			expect(t.view().replicableRowCount).toBe(0);
			t.observe(sim(21, 57), 3_000);
			// Expected final done = B = 21, so ranking, with no time left.
			t.observe(RANKING, 5_000);
			expect(t.view().activity).toBe('ranking');
			expect(t.view().remainingMs).toBeUndefined();
		});

		it("names the re-sims at ranking and sizes their stage from the engine's restated total", () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 3; i++) t.observe(row(false), 1_500);
			for (let i = 0; i < 7; i++) t.observe(row(true), 1_500);
			t.observe(sim(21, 57), 3_000);
			t.observe(RANKING, 5_000);
			expect(t.view().activity).toBe('replication');
			// The engine restates the total as 21 + 4 * (1 + 3) = 37: 16 re-sims.
			t.observe(sim(21, 37), 5_000);
			startClock(t, 5_000);
			expect(t.view()).toMatchObject({ activity: 'replication', total: 37 });
			// m = 2 at 5700 ms: (5700 - 5000) / 2 * (16 - 2)
			t.observe(sim(23, 37), 5_700);
			expect(t.view().remainingMs).toBeCloseTo(4_900, 6);
			t.observe(sim(37, 37), 9_000);
			expect(t.view().activity).toBe('ranking');
		});

		it("counts a row after the boundary event, then takes the engine's total", () => {
			const t = tracker(4);
			t.observe(sim(1, 57), 1_000);
			for (let i = 0; i < 10; i++) t.observe(row(true), 1_500);
			t.observe(sim(21, 57), 3_000);
			// Q = 1 in the set stage.
			t.observe(row(false), 3_010);
			expect(t.view().replicableRowCount).toBe(1);
			t.observe(RANKING, 5_000);
			expect(t.view().activity).toBe('replication');
			// The engine restates 33 = 21 + 4 * (1 + 2): two rows, not the one
			// counted, so the stage holds 12 re-sims.
			t.observe(sim(21, 33), 5_000);
			startClock(t, 5_000);
			expect(t.view()).toMatchObject({ activity: 'replication', total: 33 });
			// 30 is past the projected 29 but short of 33: m = 9, 3000 / 9 * (12 - 9)
			t.observe(sim(30, 33), 8_000);
			expect(t.view().activity).toBe('replication');
			expect(t.view().remainingMs).toBeCloseTo(1_000, 6);
			t.observe(sim(33, 33), 9_000);
			expect(t.view().activity).toBe('ranking');
		});

		// A timeline with no restated total: the projection's self-check.
		const timeline = (over: Partial<RunTimeline>): RunTimeline => ({
			sims: [
				{ t: 1_000, done: 1, afterRanking: false },
				{ t: 3_000, done: 21, afterRanking: false },
				{ t: 8_000, done: 30, afterRanking: true },
			],
			rankingAt: 5_000,
			total: 57,
			doneAtLastCandidate: 21,
			concurrency: 4,
			now: 8_000,
			replicableRowCount: 1,
			seedCount: 5,
			topN: 8,
			...over,
		});

		it('uses total when a replication event passes the projection and no total was restated', () => {
			// Projection 21 + 4 * (1 + 1) = 29; done 30 > 29, so total 57.
			expect(expectedFinalDone(timeline({}))).toBe(57);
		});

		it('returns the restated total when there is one', () => {
			expect(expectedFinalDone(timeline({ finalTotal: 33 }))).toBe(33);
		});
	});

	describe('when the estimate is shown', () => {
		it('hides the estimate from a Stop on', () => {
			const t = tracker();
			t.observe(sim(1, 100, 63), 0);
			startClock(t, 0);
			endSims(t, ids('s', 19), 1_900);
			t.observe(sim(20, 100, 63), 1_900);
			expect(t.view().remainingMs).toBeDefined();
			t.noteStop();
			expect(t.view().remainingMs).toBeUndefined();
			t.observe(sim(21, 100), 2_000);
			t.observe(RANKING, 2_100);
			expect(t.view().remainingMs).toBeUndefined();
		});
	});
});
