import { describe, expect, it, vi } from 'vitest';

import {
	composedRequest,
	COPY_OFFSET,
	equippedIds,
	HANDS_SLOT,
	ITEM_VALUE,
	ITERATIONS,
	LEGS_SLOT,
	modelDps,
	NEUTRAL,
	SET_BONUSES,
	SET_KEPT_OFFSET,
	SIM_VERSION,
	THUNDERHEART,
} from '../../testing/set_bonus_scenario';
import { getItem } from './items';
import { type RaidSimRequest, simCacheKey } from './seams/sim-runner';
import { applyCopies, applySetLessCopies, measureSameGearBonus, SET_KEPT_ID_OFFSET, SET_LESS_ID_OFFSET } from './set-less-copies';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe('measureSameGearBonus', () => {
	it('returns the error of a request it cannot build', async () => {
		const runSim = () => Promise.resolve({ dps: 1, se: 0 });
		// A database with no rows, so neither copy of the hands can be built.
		const request = composedRequest({ hands: THUNDERHEART.hands, legs: THUNDERHEART.legs }, { items: [] });
		expect(await measureSameGearBonus(runSim, request, [HANDS_SLOT, LEGS_SLOT], 1)).toEqual({
			buildError: `the request database has no row for item ${THUNDERHEART.hands}`,
		});
		// With `requestsFor`, its failure for either request is returned as is.
		expect(
			await measureSameGearBonus(runSim, request, [HANDS_SLOT, LEGS_SLOT], 1, () => Promise.resolve([request, { buildError: 'the off request failed' }])),
		).toEqual({ buildError: 'the off request failed' });
	});
});

function playerDatabase(req: RaidSimRequest): { items: Array<Record<string, unknown>> } | undefined {
	const raid = (req as { raid: { parties: Array<{ players: unknown[] }> } }).raid;
	const player = raid.parties[0]?.players[0] as {
		database?: { items: Array<Record<string, unknown>> };
	};
	return player.database;
}

describe('set-less copies', () => {
	it('a copy swaps the id, keeps the stats and drops the set', () => {
		expect(SET_LESS_ID_OFFSET).toBe(COPY_OFFSET);
		const getSetId = (id: number) => getItem(id)?.setId;

		// No database, as in the model sim's own runs: the ids swap only.
		const plain = composedRequest({
			hands: THUNDERHEART.hands,
			legs: NEUTRAL.legs[0],
		});
		const before = JSON.stringify(plain);
		const copied = applySetLessCopies(plain, [HANDS_SLOT, LEGS_SLOT]);
		expect(JSON.stringify(plain)).toBe(before);
		expect(equippedIds(copied)[HANDS_SLOT]).toBe(COPY_OFFSET + THUNDERHEART.hands);
		expect(equippedIds(copied)[LEGS_SLOT]).toBe(COPY_OFFSET + NEUTRAL.legs[0]);
		expect(playerDatabase(copied)).toBeUndefined();
		// A request with copies is its own cache entry.
		const opts = { seed: 11, iterations: ITERATIONS };
		expect(simCacheKey(copied, SIM_VERSION, opts)).not.toBe(simCacheKey(plain, SIM_VERSION, opts));
		// A copy of a non-set item is worth what the item is: 3000 + 120.
		const neutralOnly = composedRequest({ legs: NEUTRAL.legs[0] });
		const neutralCopy = applySetLessCopies(neutralOnly, [LEGS_SLOT]);
		expect(modelDps(equippedIds(neutralOnly), getSetId)).toBe(3120);
		expect(modelDps(equippedIds(neutralCopy), getSetId)).toBe(3120);

		// With a database: one row per copy, from the real row, set fields
		// blanked, everything else kept.
		const realRow = {
			id: THUNDERHEART.hands,
			name: 'Thunderheart Gauntlets',
			setName: 'Thunderheart Harness',
			setId: 676,
			scalingOptions: { '0': { ilvl: 120 } },
		};
		const withDb = composedRequest({ hands: THUNDERHEART.hands }, { items: [realRow], gems: [] });
		const copiedDb = applySetLessCopies(withDb, [HANDS_SLOT]);
		expect(playerDatabase(copiedDb)?.items).toEqual([
			realRow,
			{
				...realRow,
				id: COPY_OFFSET + THUNDERHEART.hands,
				setName: '',
				setId: 0,
			},
		]);
		expect(playerDatabase(withDb)?.items).toEqual([realRow]);

		// A set-kept copy: the real row with only `id` changed, so the copy
		// still counts toward its set.
		expect(SET_KEPT_ID_OFFSET).toBe(SET_KEPT_OFFSET);
		const keptDb = applyCopies(withDb, { setKept: [HANDS_SLOT] });
		expect(equippedIds(keptDb)[HANDS_SLOT]).toBe(SET_KEPT_OFFSET + THUNDERHEART.hands);
		expect(playerDatabase(keptDb)?.items).toEqual([realRow, { ...realRow, id: SET_KEPT_OFFSET + THUNDERHEART.hands }]);
		// Without a database only the ids swap; both kinds in one request.
		const both = applyCopies(plain, {
			setLess: [LEGS_SLOT],
			setKept: [HANDS_SLOT],
		});
		expect(equippedIds(both)[HANDS_SLOT]).toBe(SET_KEPT_OFFSET + THUNDERHEART.hands);
		expect(equippedIds(both)[LEGS_SLOT]).toBe(COPY_OFFSET + NEUTRAL.legs[0]);
		expect(playerDatabase(both)).toBeUndefined();
		// The model counts a set-kept copy toward its set: 3000 + 100 + 120.
		expect(modelDps(equippedIds(both), getSetId)).toBe(3220);
	});

	it('an interaction term needs every listed id worn; a copy counts as its original', () => {
		const setOf = (id: number) => (id === THUNDERHEART.hands || id === THUNDERHEART.legs ? 676 : undefined);
		const term = [{ ids: [THUNDERHEART.hands, THUNDERHEART.legs], dps: 9 }];
		const dps = (ids: number[]) => modelDps(ids, setOf, ITEM_VALUE, SET_BONUSES, term);
		// Both worn: 3000 + 100 + 100 + 2pc 50 + 9.
		expect(dps([THUNDERHEART.hands, THUNDERHEART.legs])).toBe(3259);
		// One worn: no 2pc and no term.
		expect(dps([THUNDERHEART.hands])).toBe(3100);
		// The hands as a copy: the term stays and the 2pc goes.
		expect(dps([COPY_OFFSET + THUNDERHEART.hands, THUNDERHEART.legs])).toBe(3209);
	});
});
