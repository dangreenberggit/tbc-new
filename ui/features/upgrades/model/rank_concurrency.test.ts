/**
 * Sims at the runner's concurrency. The web build runs each sim on one WASM worker, so a step
 * that sends its sims one at a time leaves the other workers idle; a feral web run's set-bonus
 * and replication steps once took 509 s and 540 s that way. On the model sim of
 * `testing/set_bonus_scenario.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	MALORNE,
	NORDRASSIL,
	runScenario,
	type Scenario,
	SCREEN_RUN_SCENARIO,
	STOP_SCENARIOS,
	TH_POOL,
	THUNDERHEART,
	wornGear,
} from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe("Sims at the runner's concurrency", () => {
	const piecesOf = (set: Record<string, number>, ids: readonly number[]) => ids.filter(id => Object.values(set).includes(id)).length;
	const REPLICATION_SCENARIO: Scenario = {
		...SCREEN_RUN_SCENARIO,
		setScreenMode: 'on',
		seeds: 'engine-default',
		iterations: 3000,
	};
	// Three sets the pool can each add two or more pieces of.
	const THREE_SETS_SCENARIO: Scenario = {
		worn: wornGear({}),
		pool: [
			...TH_POOL,
			...(['head', 'shoulder', 'hands', 'legs', 'chest'] as const).flatMap(slot => [
				{ itemId: MALORNE[slot], slot },
				{ itemId: NORDRASSIL[slot], slot },
			]),
		],
		measureSetBonuses: true,
		reportsSetBonuses: true,
		setScreenMode: 'on',
	};
	const SCENARIOS: ReadonlyArray<readonly [string, Scenario]> = [
		...STOP_SCENARIOS,
		['the screen-run gear, five seeds', REPLICATION_SCENARIO],
		['three sets, screen on', THREE_SETS_SCENARIO],
		['three sets, flag off', { ...THREE_SETS_SCENARIO, measureSetBonuses: false }],
		// Run notes are part of the ranking. Two sets' sims fail, the first
		// set's last, so their notes must not follow the finish order.
		[
			"three sets, two sets' sims failing",
			{
				...THREE_SETS_SCENARIO,
				failWhen: ids => [THUNDERHEART, MALORNE].some(set => piecesOf(set, ids) >= 2),
				extraDelayMs: ids => (piecesOf(THUNDERHEART, ids) >= 2 ? 30 : 0),
			},
		],
	];

	it("runs the replication sims up to the runner's concurrency at once", async () => {
		const run = await runScenario({ ...REPLICATION_SCENARIO, concurrency: 4 });
		// Replication is the only step that sims at a seed other than the first.
		const replication = run.callOpts.flatMap((o, i) => (o.seed === 11 ? [] : [run.inFlightAtStart[i]!]));
		expect(replication.length).toBeGreaterThan(4);
		expect(Math.max(...replication)).toBe(4);
	});

	it("runs the set screen's sims for different sets at once", async () => {
		const run = await runScenario({ ...THREE_SETS_SCENARIO, concurrency: 4 });
		// Only the screen asks for per-iteration values.
		const screen = run.callOpts.flatMap((o, i) => (o.saveAllValues === true ? [run.inFlightAtStart[i]!] : []));
		expect(screen.length).toBeGreaterThan(2);
		expect(Math.max(...screen)).toBeGreaterThan(1);
	});

	it('runs the set-bonus value sims for different sets at once', async () => {
		// With the flag off no screen, worn-set or bonus-gear sim runs. Nothing
		// is worn, so a candidate sim wears one item and a set-bonus value sim
		// two or more.
		const run = await runScenario({
			...THREE_SETS_SCENARIO,
			measureSetBonuses: false,
			concurrency: 4,
		});
		const setPhase = run.calls.flatMap((ids, i) => (ids.filter(id => id > 0).length >= 2 ? [run.inFlightAtStart[i]!] : []));
		expect(setPhase.length).toBeGreaterThan(2);
		expect(Math.max(...setPhase)).toBeGreaterThan(1);
	});

	it("runs the partner choice's sims for different rows at once", async () => {
		const run = await runScenario({ ...THREE_SETS_SCENARIO, concurrency: 4 });
		// V8 rebuilds only part of an async stack, so a partner-choice sim's stack
		// names either its step (`choosePartnerGears`) or its own sim call
		// (`simCloseCall`).
		const partnerChoice = run.stackAtStart.flatMap((stack, i) => (/\b(choosePartnerGears|simCloseCall)\b/.test(stack) ? [run.inFlightAtStart[i]!] : []));
		expect(partnerChoice.length).toBeGreaterThan(2);
		expect(Math.max(...partnerChoice)).toBeGreaterThan(1);
	});

	it.each(SCENARIOS)(
		'%s: gives the same ranking at concurrency 4 as one sim at a time',
		async (_name, scenario) => {
			const serial = await runScenario(scenario);
			const parallel = await runScenario({ ...scenario, concurrency: 4 });
			expect(parallel.ranking).toEqual(serial.ranking);
		},
		120_000,
	);
});
