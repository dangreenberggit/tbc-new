/**
 * The popover's split break lines: an increment that newly loses a worn bonus is split into its
 * Breaks line and its pieces line by one bonus-off sim, on the model sim of
 * `testing/set_bonus_scenario.ts`. Every literal is derived by hand from that model.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	breakSplitFailedLine,
	COPY_OFFSET,
	expectSplitLinesAddUp,
	FLOOR,
	futureOf,
	idsOf,
	MALORNE,
	NEUTRAL,
	PS_SCENARIO,
	R_SCENARIO,
	runScenario,
	type Scenario,
	type ScenarioRanking,
	type ScenarioRow,
	SET_BONUSES,
	setPool,
	setSkipLines,
	SWEEP_BONUSES,
	SWEEP_TH_ORDER,
	type SweepSlot,
	thRow,
	THUNDERHEART,
	V_TH,
	withValues,
	wornGear,
} from '../testing/set_bonus_scenario';
import { rankableSetPotential, setCreditUnmeasured, setPotentialIncrements } from './engine/set-potential';

// The engine reads items and gems through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const bonusOffOf = futureOf;

const nineOrNull = (v: number | undefined) => (v === undefined ? null : Number(v.toFixed(9)));

/**
 * A row's increments as [count, added piece ids, dps, Breaks line, pieces line,
 * newly broken]; a line value is null when the increment is not split.
 */
function splitIncrementsOf(row: ScenarioRow) {
	return setPotentialIncrements(row.setContext, FLOOR)?.map(s => [
		s.threshold,
		s.pieces.map(p => p.itemId),
		Number(s.dps.toFixed(9)),
		nineOrNull(s.breaksLineDps),
		nineOrNull(s.piecesLineDps),
		s.broken.map(b => [b.setId, b.threshold]),
	]);
}

const ZERO_BONUS_OFF = {
	gears: 0,
	simmed: 0,
	fromStore: 0,
	failedGears: 0,
	skippedIncrements: 0,
	beforeInStore: 0,
};

// PS_SCENARIO's worn Malorne shoulder and chest, two Thunderheart pool pieces, and a
// Thunderheart 2pc large enough to pay for the break.
const LR_SCENARIO: Scenario = {
	worn: wornGear({ shoulder: MALORNE.shoulder, chest: MALORNE.chest }),
	pool: [
		{ itemId: THUNDERHEART.chest, slot: 'chest' },
		{ itemId: THUNDERHEART.hands, slot: 'hands' },
	],
	setBonuses: {
		...SET_BONUSES,
		640: { b2: 90, b4: 0 },
		676: { b2: 150, b4: 80 },
	},
	itemValue: withValues([
		[THUNDERHEART.chest, 12],
		[THUNDERHEART.hands, 6],
	]),
	measureSetBonuses: true,
};

describe("the popover's split break lines", () => {
	it('an increment that newly loses a worn bonus is split into its Breaks line and its pieces line', async () => {
		// Scenario kind: the owner's demo row, a 4pc increment that replaces both
		// worn Malorne pieces. Example: PS_SCENARIO (feral P2 BiS shape).
		const run = await runScenario(PS_SCENARIO);
		const r = run.ranking;
		const hands = thRow(r, THUNDERHEART.hands);
		const legs = thRow(r, THUNDERHEART.legs);
		// The gear before the 4pc increment, Gauntlets + Leggings, is +44; with the
		// Malorne shoulder and chest set-less it is 6 − 12 + 50 − 90 = −46.
		// Breaks −46 − 44 = −90; pieces 54 − (−46) = 100; −90 + 100 = 10.
		expect(splitIncrementsOf(hands)).toEqual([
			[2, [THUNDERHEART.legs], 38, null, null, []],
			[4, [THUNDERHEART.shoulder, THUNDERHEART.chest], 10, -90, 100, [[640, 2]]],
		]);
		// The Leggings row's 4pc increment has the same gear before (folded in slot
		// order) and the same replaced pieces, so it shares the sim.
		expect(splitIncrementsOf(legs)).toEqual([
			[2, [THUNDERHEART.hands], 56, null, null, []],
			[4, [THUNDERHEART.shoulder, THUNDERHEART.chest], 10, -90, 100, [[640, 2]]],
		]);
		for (const row of [hands, legs]) {
			const f = bonusOffOf(row, 4)!;
			expect(f.bonusOffDps).toBeCloseTo(-46, 9);
			expect(f.bonusOff).toEqual([{ setId: 640, threshold: 2 }]);
			expect(f.bonusOffSe).toBe(futureOf(row, 4)?.bonusGearSe);
			expect(bonusOffOf(row, 2)?.bonusOffDps).toBeUndefined();
		}
		// Their own swap already broke Malorne 2pc: no increment newly loses it.
		for (const id of [THUNDERHEART.shoulder, THUNDERHEART.chest]) {
			const row = thRow(r, id);
			for (const s of splitIncrementsOf(row) ?? []) {
				expect(s[3]).toBeNull();
				expect(s[4]).toBeNull();
			}
			for (const f of row.setContext?.futureBonuses ?? []) {
				expect(f.bonusOffDps).toBeUndefined();
			}
		}
		expect(r.setBonusOffSims).toEqual({
			gears: 1,
			simmed: 1,
			fromStore: 0,
			failedGears: 0,
			skippedIncrements: 0,
			beforeInStore: 1,
		});
		const offIds = [COPY_OFFSET + MALORNE.shoulder, COPY_OFFSET + MALORNE.chest, THUNDERHEART.hands, THUNDERHEART.legs];
		expect(run.calls.filter(ids => offIds.every(id => ids.includes(id)))).toHaveLength(1);
		expect(expectSplitLinesAddUp(r)).toBe(2);
	});

	it('increments that break nothing are not split and add no sim', async () => {
		// Scenario kind: nothing worn, so no increment can lose a worn bonus.
		// Example: R_SCENARIO.
		const { ranking: r } = await runScenario(R_SCENARIO);
		expect(splitIncrementsOf(thRow(r, THUNDERHEART.hands))).toEqual([
			[2, [THUNDERHEART.chest], 150, null, null, []],
			[4, [THUNDERHEART.shoulder, THUNDERHEART.legs], 240, null, null, []],
		]);
		for (const row of r.items) {
			for (const f of row.setContext?.futureBonuses ?? []) {
				expect(f.bonusOffDps).toBeUndefined();
				expect(f.bonusOff).toBeUndefined();
			}
		}
		expect(expectSplitLinesAddUp(r)).toBe(0);
		expect(r.setBonusOffSims).toEqual(ZERO_BONUS_OFF);
		expect(r.bonusGearSims).toEqual({
			partnerRule: 'close-calls',
			gears: 4,
			simmed: 5,
			fromStore: 11,
		});
	});

	it("a first increment's bonus-off request is the row's single-swap request with copies", async () => {
		// Scenario kind: a row whose first increment breaks a worn bonus, so the
		// gear before the increment is the row's own single swap. Example: worn
		// Malorne shoulder and chest, Gauntlets row with a Chestguard partner.
		const run = await runScenario(LR_SCENARIO);
		const r = run.ranking;
		const hands = thRow(r, THUNDERHEART.hands);
		expect(hands.setContext?.singleDeltaDps).toBeCloseTo(6, 9);
		// 2pc with the Chestguard: 6 + 12 + 150 − 90 = 78, an increment of 72. The
		// Gauntlets swap with the Malorne chest set-less: 6 − 90 = −84.
		// Breaks −84 − 6 = −90; pieces 78 − (−84) = 162.
		expect(splitIncrementsOf(hands)).toEqual([[2, [THUNDERHEART.chest], 72, -90, 162, [[640, 2]]]]);
		// The Chestguard row breaks Malorne 2pc itself: 12 − 90 = −78; its
		// increment with the Gauntlets is 78 − (−78) = 156 and is not split.
		const chest = thRow(r, THUNDERHEART.chest);
		expect(chest.deltaDps).toBeCloseTo(-78, 9);
		expect(splitIncrementsOf(chest)).toEqual([[2, [THUNDERHEART.hands], 156, null, null, []]]);
		expect(r.setBonusOffSims).toEqual({
			gears: 1,
			simmed: 1,
			fromStore: 0,
			failedGears: 0,
			skippedIncrements: 0,
			beforeInStore: 1,
		});
		// Request identity: undo the copy and the bonus-off request is the request that
		// gave the Gauntlets row's single swap.
		const copyId = COPY_OFFSET + MALORNE.chest;
		const offAt = run.calls.findIndex(ids => ids.includes(copyId) && ids.includes(THUNDERHEART.hands) && !ids.includes(THUNDERHEART.chest));
		expect(offAt).toBeGreaterThanOrEqual(0);
		const undone = structuredClone(run.requests[offAt]!) as unknown as {
			raid: {
				parties: Array<{
					players: Array<{
						equipment: { items: Array<{ id?: number }> };
						database?: { items?: Array<{ id?: number }> };
					}>;
				}>;
			};
		};
		const player = undone.raid.parties[0]!.players[0]!;
		const copied = player.equipment.items.find(i => i.id === copyId)!;
		copied.id = MALORNE.chest;
		if (player.database?.items) {
			player.database.items = player.database.items.filter(row => row.id !== copyId);
		}
		const singleIds = idsOf({
			shoulder: MALORNE.shoulder,
			chest: MALORNE.chest,
			hands: THUNDERHEART.hands,
		});
		const singleAt = run.calls.findIndex((ids, i) => JSON.stringify(ids) === JSON.stringify(singleIds) && run.callOpts[i]!.saveAllValues !== true);
		expect(singleAt).toBeGreaterThanOrEqual(0);
		expect(undone).toEqual(run.requests[singleAt]);
		expect(expectSplitLinesAddUp(r)).toBe(1);
	});

	it('a failed bonus-off sim leaves the increment unsplit', async () => {
		// Scenario kind: the bonus-off sim fails. Example: PS_SCENARIO with
		// the fake sim failing the one request that wears the Malorne
		// shoulder's set-less copy with the Gauntlets and the Leggings.
		const failId = COPY_OFFSET + MALORNE.shoulder;
		const { ranking: r } = await runScenario({
			...PS_SCENARIO,
			failWhen: ids => ids.includes(failId) && ids.includes(THUNDERHEART.hands) && ids.includes(THUNDERHEART.legs),
		});
		const hands = thRow(r, THUNDERHEART.hands);
		const legs = thRow(r, THUNDERHEART.legs);
		const fourPc = [4, [THUNDERHEART.shoulder, THUNDERHEART.chest], 10, null, null, [[640, 2]]];
		expect(splitIncrementsOf(hands)).toEqual([[2, [THUNDERHEART.legs], 38, null, null, []], fourPc]);
		expect(splitIncrementsOf(legs)).toEqual([[2, [THUNDERHEART.hands], 56, null, null, []], fourPc]);
		for (const row of [hands, legs]) {
			const f = bonusOffOf(row, 4)!;
			expect(f.bonusOffDps).toBeUndefined();
			expect(f.bonusOffSe).toBeUndefined();
			expect(f.bonusOff).toBeUndefined();
			expect(setCreditUnmeasured(row.setContext)).toBe(false);
		}
		expect(r.setBonusOffSims).toEqual({
			gears: 1,
			simmed: 0,
			fromStore: 0,
			failedGears: 1,
			skippedIncrements: 0,
			beforeInStore: 1,
		});
		// The bonus-off sim's error names the lost Malorne 2pc, whose cost the
		// increment does not show apart from its pieces.
		expect(setSkipLines(r)).toEqual([breakSplitFailedLine(2)]);
		// The credits are PS_SCENARIO's: 54 − 6 and 54 + 12.
		expect(rankableSetPotential(hands, FLOOR)).toBeCloseTo(48, 9);
		expect(rankableSetPotential(legs, FLOOR)).toBeCloseTo(66, 9);
	});
});

/** Five sweep slots, with Thunderheart in the first `k` of the live sweep's order and a neutral piece in the rest. */
function sweepWorn(k: number): Record<SweepSlot, number> {
	const worn: Record<SweepSlot, number> = {
		head: NEUTRAL.head[0],
		shoulder: NEUTRAL.shoulder[0],
		chest: NEUTRAL.chest[0],
		hands: NEUTRAL.hands[0],
		legs: NEUTRAL.legs[0],
	};
	for (const slot of SWEEP_TH_ORDER.slice(0, k)) {
		worn[slot] = THUNDERHEART[slot];
	}
	return worn;
}

describe('worn Thunderheart sweep, the printed 4pc lines', () => {
	// Screen off: the scenarios send no `setScreenMode`, so every set is measured.

	it('a stat interaction on the 4pc gear moves the pieces line, not the Breaks line', async () => {
		// Scenario kind: worn Thunderheart hands and legs (k = 2), the Malorne
		// head row. Thunderheart hands are worth 300 so no Malorne 4pc replaces
		// them; the 4pc gear is Malorne head, shoulder, chest and legs over the
		// worn Thunderheart hands, and its increment replaces the Thunderheart legs,
		// losing the Thunderheart 2pc (-50). The interaction (Malorne shoulder
		// + chest + Thunderheart hands, -15) fires on the 4pc gear only, not on
		// the gear the Breaks line prices.
		const values = withValues([...Object.values(MALORNE).map(id => [id, V_TH] as const), [THUNDERHEART.hands, 300]]);
		const scenario: Scenario = {
			worn: wornGear(sweepWorn(2)),
			pool: [...setPool(MALORNE), { itemId: NEUTRAL.hands[0], slot: 'hands' }, { itemId: NEUTRAL.legs[0], slot: 'legs' }],
			itemValue: values,
			setBonuses: SWEEP_BONUSES,
			measureSetBonuses: true,
		};
		const plain = await runScenario(scenario);
		const withTerm = await runScenario({
			...scenario,
			interactions: [
				{
					ids: [MALORNE.shoulder, MALORNE.chest, THUNDERHEART.hands],
					dps: -15,
				},
			],
		});
		const increment4Of = (r: ScenarioRanking) => setPotentialIncrements(thRow(r, MALORNE.head).setContext, FLOOR)?.find(s => s.threshold === 4);
		const a = increment4Of(plain.ranking);
		const b = increment4Of(withTerm.ranking);
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		for (const s of [a!, b!]) {
			const ids = s.pieces.map(p => p.itemId);
			expect(ids).toContain(MALORNE.legs);
			expect(ids).not.toContain(MALORNE.hands);
			expect(s.broken.map(x => [x.setId, x.threshold])).toEqual([[676, 2]]);
		}
		// Hand-derived: Breaks -50; pieces -20 (a neutral shoulder or chest
		// replaced) + 0 (Thunderheart legs replaced) + 400 = 380, and 365 with
		// the interaction.
		expect(a!.breaksLineDps).toBeCloseTo(-50, 9);
		expect(a!.piecesLineDps).toBeCloseTo(380, 9);
		expect(b!.breaksLineDps).toBeCloseTo(-50, 9);
		expect(b!.piecesLineDps).toBeCloseTo(365, 9);
	});
});
