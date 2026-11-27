/**
 * Stop after the candidate loop: a Stop during any later sim sends no further sim and gives
 * the result of a Stop during the last candidate sim, on the model sim of
 * `testing/set_bonus_scenario.ts`. No hand-derived literals.
 */

import { describe, expect, it, vi } from 'vitest';

import { COPY_OFFSET, runScenario, type Scenario, SR_SCENARIO, STOP_SCENARIOS } from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

// Every feral run reads hit, so each meta repair searches with the hit term, and several
// cases run 15-27 s alone, near the default timeout.
vi.setConfig({ testTimeout: 120_000 });

/**
 * The first set-phase sim's call index: candidate requests carry no copy
 * id, and the set phase's first sim always does.
 */
const firstSetPhaseCall = (calls: readonly number[][]) => calls.findIndex(ids => ids.some(id => id >= COPY_OFFSET));

describe('Stop after the candidate loop', () => {
	for (const [name, scenario] of STOP_SCENARIOS) {
		it(`${name}: a Stop during any set-phase sim sends no further sim, writes no sim-failure warning, and returns the last-candidate Stop result`, async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			try {
				const full = await runScenario(scenario);
				expect(full.ranking.complete).toBe(true);
				// The model sim never fails, so a full run writes no warning.
				expect(warn).not.toHaveBeenCalled();
				const first = firstSetPhaseCall(full.calls);
				expect(first).toBeGreaterThan(0);
				const before = await runScenario({
					...scenario,
					stopDuringCall: first - 1,
				});
				// No set-phase sim ran, so `first` is the set phase's first sim.
				expect(before.runCount).toBe(first);
				expect(before.ranking.complete).toBe(false);
				for (let i = first; i < full.runCount; i++) {
					warn.mockClear();
					const stopped = await runScenario({ ...scenario, stopDuringCall: i });
					expect(stopped.runCount, `Stop during call ${i}`).toBe(i + 1);
					expect(stopped.ranking, `Stop during call ${i}`).toEqual(before.ranking);
					expect(warn, `Stop during call ${i}`).not.toHaveBeenCalled();
				}
			} finally {
				warn.mockRestore();
			}
		}, 120_000);
	}

	it('a Stop during any set-bonus read sends no further sim, writes no warning, and returns the last-candidate Stop result', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const [name, scenario] of STOP_SCENARIOS) {
				const full = await runScenario(scenario);
				expect(full.setBonusReadRuns.length, name).toBeGreaterThan(1);
				const before = await runScenario({
					...scenario,
					stopDuringCall: firstSetPhaseCall(full.calls) - 1,
				});
				for (let j = 0; j < full.setBonusReadRuns.length; j++) {
					warn.mockClear();
					const at = `${name}, Stop during read ${j}`;
					const stopped = await runScenario({
						...scenario,
						stopDuringSetBonusRead: j,
					});
					expect(stopped.runCount, at).toBe(full.setBonusReadRuns[j]);
					expect(stopped.ranking, at).toEqual(before.ranking);
					expect(warn, at).not.toHaveBeenCalled();
				}
			}
		} finally {
			warn.mockRestore();
		}
	}, 120_000);

	it('a Stop during any replication sim sends no further sim and returns the last-candidate Stop result', async () => {
		const scenario: Scenario = {
			...SR_SCENARIO,
			setScreenMode: 'on',
			// At least ITERATIONS apart, or the seed guard refuses them.
			seeds: [11, 5011, 10011],
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const full = await runScenario(scenario);
			expect(full.ranking.complete).toBe(true);
			expect(warn).not.toHaveBeenCalled();
			expect(full.ranking.items.some(r => r.seMethod === 'paired-replicate')).toBe(true);
			const firstSet = firstSetPhaseCall(full.calls);
			const firstReplica = full.callOpts.findIndex(o => o.seed !== 11);
			expect(firstReplica).toBeGreaterThan(firstSet);
			// Replication is the run's tail: every later sim is at another seed.
			expect(full.callOpts.slice(firstReplica).every(o => o.seed !== 11)).toBe(true);
			const before = await runScenario({
				...scenario,
				stopDuringCall: firstSet - 1,
			});
			expect(before.runCount).toBe(firstSet);
			for (let i = firstReplica; i < full.runCount; i++) {
				warn.mockClear();
				const stopped = await runScenario({ ...scenario, stopDuringCall: i });
				expect(stopped.runCount, `Stop during call ${i}`).toBe(i + 1);
				expect(stopped.ranking, `Stop during call ${i}`).toEqual(before.ranking);
				expect(warn, `Stop during call ${i}`).not.toHaveBeenCalled();
			}
		} finally {
			warn.mockRestore();
		}
	}, 120_000);

	it('the full runs send every kind of set-phase sim, so the Stop cases stop inside each', async () => {
		const fulls = await Promise.all(STOP_SCENARIOS.map(([, scenario]) => runScenario(scenario)));
		const rankings = fulls.map(f => f.ranking);
		const kinds = {
			'worn-set counts': rankings.some(r => (r.wornSetLadder ?? []).some(e => e.dps !== undefined)),
			'set screen': fulls.some(f => f.callOpts.some(o => o.saveAllValues === true)),
			'same-gear check': rankings.some(r => (r.setBonuses ?? []).some(e => e.sameGearDps !== undefined)),
			'package sim': rankings.some(r => (r.setBonuses ?? []).some(e => e.bonusDps !== undefined)),
			'worn-1 pair sim': rankings.some(r => (r.setBonuses ?? []).some(e => e.selfConfound?.dps !== undefined)),
			'crossing check': rankings.some(r => (r.crossingChecks ?? []).some(e => e.dps !== undefined)),
			'bonus-gear sim': rankings.some(r => (r.bonusGearSims?.simmed ?? 0) > 0),
			'bonus-off sim': rankings.some(r => (r.setBonusOffSims?.simmed ?? 0) > 0),
		};
		expect(kinds).toEqual({
			'worn-set counts': true,
			'set screen': true,
			'same-gear check': true,
			'package sim': true,
			'worn-1 pair sim': true,
			'crossing check': true,
			'bonus-gear sim': true,
			'bonus-off sim': true,
		});
	}, 120_000);
});
