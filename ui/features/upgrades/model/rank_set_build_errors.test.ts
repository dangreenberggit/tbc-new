/**
 * Set-phase requests that cannot be built: each gives a ranking line that ends in the error
 * that was caught and does not say a sim failed, on the model sim of
 * `testing/set_bonus_scenario.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bonusOf,
	CHEST_SLOT,
	HANDS_SLOT,
	LEGS_SLOT,
	MALORNE,
	MALORNE_SHOULDER_CHEST_SCENARIO,
	MODEL_COMPOSE_ERROR,
	runScenario,
	type Scenario,
	setSkipLines,
	SHOULDER_SLOT,
	TH_FOUR_POOL,
	TH_POOL,
	THUNDERHEART,
	wornGear,
} from '../testing/set_bonus_scenario';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const NO_ROW_ERROR = String.raw`the request database has no row for item \d+`;
const TH_IDS = Object.values(THUNDERHEART);

const noRowError = (itemId: number) => `the request database has no row for item ${itemId}`;

describe('set requests that cannot be built', () => {
	const noThunderheartRows: Scenario = {
		worn: wornGear({}),
		pool: TH_POOL,
		measureSetBonuses: true,
		databaseWithout: TH_IDS,
	};

	it('a set screen whose rung requests cannot be built keeps the set, and a line gives the error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { ranking } = await runScenario({
				...noThunderheartRows,
				setScreenMode: 'on',
			});
			expect(ranking.setScreen?.sets.find(set => set.setId === 676)?.kept).toBe(true);
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Thunderheart Harness set',
				detail: "The Thunderheart Harness set was kept without the quick check that can skip it, because the check's sim could not be built.",
				error: expect.stringMatching(new RegExp(`^${NO_ROW_ERROR}$`)),
			});
		} finally {
			warn.mockRestore();
		}
	});

	it('a same-gear check whose requests cannot be built gives a line with the error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const { ranking } = await runScenario(noThunderheartRows);
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Thunderheart Harness 2-piece set bonus',
				detail: 'The Thunderheart Harness 2-piece set bonus was not measured, because the sims that measure it could not be built.',
				error: expect.stringMatching(new RegExp(`^${NO_ROW_ERROR}$`)),
			});
		} finally {
			warn.mockRestore();
		}
	});
});

describe('more set requests that cannot be built', () => {
	const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

	it('a package whose own request cannot be built names the error, not a failed sim', async () => {
		// Without the broken-set flag the package's plain request is composed
		// only inside the set phase's versions, so a compose of any gear with
		// two or more Thunderheart pieces fails there.
		const thIds: readonly number[] = Object.values(THUNDERHEART);
		const warn = quiet();
		try {
			const { ranking } = await runScenario({
				worn: wornGear({}),
				pool: TH_POOL,
				composeFailsWhen: ids => ids.filter(id => thIds.includes(id)).length >= 2,
			});
			expect(bonusOf(ranking, 676, 2)?.unmeasured).toBe('sim-failed');
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Thunderheart Harness 2-piece set bonus',
				detail: 'The Thunderheart Harness 2-piece set bonus was not measured, because the sims that measure it could not be built.',
				error: MODEL_COMPOSE_ERROR,
			});
		} finally {
			warn.mockRestore();
		}
	});

	it('a bonus gear whose request cannot be built gives a line on some rows', async () => {
		// Four Thunderheart pieces and nothing worn, with the compose of each
		// Pauldrons 2pc bonus gear failing in place of its sim.
		const thSlots = [SHOULDER_SLOT, CHEST_SLOT, HANDS_SLOT, LEGS_SLOT];
		const warn = quiet();
		try {
			const { ranking } = await runScenario({
				worn: wornGear({}),
				pool: TH_FOUR_POOL,
				measureSetBonuses: true,
				composeFailsWhen: ids => ids[SHOULDER_SLOT] === THUNDERHEART.shoulder && thSlots.filter(slot => ids[slot] !== 0).length === 2,
			});
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Thunderheart Harness 2-piece set bonus',
				detail: 'The Thunderheart Harness 2-piece set bonus was not measured on some rows, because their sims could not be built.',
				error: MODEL_COMPOSE_ERROR,
			});
		} finally {
			warn.mockRestore();
		}
	});

	it('a bonus-off request that cannot be built gives the break-split line with the error', async () => {
		// MALORNE_SHOULDER_CHEST_SCENARIO's bonus-off request, the Malorne shoulder's set-less copy with
		// the Gauntlets and the Leggings, with no row to copy the shoulder from.
		const warn = quiet();
		try {
			const { ranking } = await runScenario({
				...MALORNE_SHOULDER_CHEST_SCENARIO,
				databaseOmits: ids =>
					ids.includes(MALORNE.shoulder) && ids.includes(THUNDERHEART.hands) && ids.includes(THUNDERHEART.legs) ? [MALORNE.shoulder] : [],
			});
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Malorne Harness 2-piece set bonus',
				detail: 'On some rows, the cost of breaking the Malorne Harness 2-piece set bonus was not measured apart from the pieces that break it, because their sim could not be built.',
				error: noRowError(MALORNE.shoulder),
			});
		} finally {
			warn.mockRestore();
		}
	});

	it('a worn-1 pair whose request cannot be built names the error, not a failed sim', async () => {
		// Worn Thunderheart hands: the pair is the one gear with exactly three real
		// Thunderheart pieces.
		const thIds: readonly number[] = Object.values(THUNDERHEART);
		const warn = quiet();
		try {
			const { ranking } = await runScenario({
				worn: wornGear({ hands: THUNDERHEART.hands }),
				pool: TH_POOL.filter(p => p.slot !== 'hands'),
				composeFailsWhen: ids => ids.filter(id => thIds.includes(id)).length === 3,
			});
			expect(bonusOf(ranking, 676, 4)!.bonusDpsNet).toBeUndefined();
			expect(setSkipLines(ranking)).toContainEqual({
				field: 'Thunderheart Harness 2-piece set bonus',
				detail: 'The Thunderheart Harness 2-piece set bonus was not measured, because the sims that measure it could not be built.',
				error: MODEL_COMPOSE_ERROR,
			});
		} finally {
			warn.mockRestore();
		}
	});
});
