/**
 * A caster's meta repair through `rankUpgrades`: the hit budget is priced by
 * the spells the baseline sim cast, each school capped at its own hit, and
 * the ranking notes a per-spell hit talent the price cannot see.
 */

import { describe, expect, it, vi } from 'vitest';

import { CHEST, holdsGem, SCHOOL } from '../testing/meta_repair_inputs';
import {
	casterRead,
	gearHitReads,
	GREAT_DAWNSTONE,
	isHitCapNote,
	requestItems,
	runSpec,
	S_POOL,
	skeletonAtLevel,
	skeletonWithTalents,
	warlockRun,
	wornWithMetaOff,
} from '../testing/meta_repair_runs';
import { epWeightsFor } from './data/data';

vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const perSpellTalentDetail = (talent: string) =>
	'If gems were swapped to turn your meta gem on, hit rating was valued ' + `as if your ${talent} talent added no hit, so it may be valued too high.`;

describe("a caster's hit is priced by the spells its sim cast", () => {
	it('a shadow priest whose cast spells are all Shadow values no hit past the Shadow cap', async () => {
		// Oracle: the page's default shadow priest is a Troll, with no
		// Starshards (`sim/priest/priest.go:58-62`), so all its damage is
		// Shadow, which Shadow Focus's 10% (126 rating) caps before slot 13.
		// 30 rating under slot 13's cap is 96 past the Shadow cap: no Great
		// Dawnstone. The same budget with the damage in Arcane, which reads
		// slot 13, takes one. Warlock weights, under which a Great Dawnstone
		// wins while hit has its full value.
		const shadow = await warlockRun({
			spec: 'shadow',
			weightsOf: 'warlock',
			bonusHit: 0,
			localBudget: 30,
			schoolBonus: { 11: 10 },
			castDamage: { [SCHOOL.shadow]: 1 },
		});
		for (const items of shadow.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(false);
		}
		const arcane = await warlockRun({
			spec: 'shadow',
			weightsOf: 'warlock',
			bonusHit: 0,
			localBudget: 30,
			schoolBonus: { 11: 10 },
			castDamage: { [SCHOOL.arcane]: 1 },
		});
		for (const items of arcane.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(true);
		}
		// Below its own cap a Shadow group still values hit: a 1% school
		// bonus leaves 30 − 12.6 = 17.4 rating, room for the 8 of a Dawnstone.
		const underShadowCap = await warlockRun({
			spec: 'shadow',
			weightsOf: 'warlock',
			bonusHit: 0,
			localBudget: 30,
			schoolBonus: { 11: 1 },
			castDamage: { [SCHOOL.shadow]: 1 },
		});
		for (const items of underShadowCap.rows) {
			expect(holdsGem(items, GREAT_DAWNSTONE)).toBe(true);
		}
	});

	it("against a target that is not level 73 a caster's worn repair runs no extra sim", async () => {
		// Oracle: with no budget the sim's spells price nothing, so the first
		// sim is the baseline, already repaired.
		const worn = wornWithMetaOff();
		const run = await runSpec({
			worn,
			pool: S_POOL,
			spec: 'shadow',
			skeleton: skeletonAtLevel(72),
			computeStats: casterRead(7, { 11: 10 }),
		});
		expect(requestItems(run.requests[0]!)[CHEST]!.gems).not.toEqual(worn[CHEST]!.gems);
	});

	it('a caster whose worn meta is off sims that gear first and prices the worn repair by its spells', async () => {
		// Oracle: slot 13 reads 7%, Shadow 17%. With the damage in Shadow no
		// hit is worth anything, so the worn repair places no Great
		// Dawnstone; with it in Arcane, 9% (113.5 rating) is left and it does.
		const weights = epWeightsFor('warlock');
		const baselineGear = async (school: number) => {
			const worn = wornWithMetaOff();
			const run = await runSpec({
				worn,
				pool: S_POOL,
				spec: 'shadow',
				epWeights: weights,
				computeStats: casterRead(7, { 11: 10 }),
				castDamage: { [school]: 1 },
			});
			expect(requestItems(run.requests[0]!)[CHEST]!.gems).toEqual(worn[CHEST]!.gems);
			expect(run.ranking.baseline?.metaAdjusted).toBe(true);
			return requestItems(run.requests[1]!);
		};
		expect(holdsGem(await baselineGear(SCHOOL.shadow), GREAT_DAWNSTONE)).toBe(false);
		expect(holdsGem(await baselineGear(SCHOOL.arcane), GREAT_DAWNSTONE)).toBe(true);
	});

	it('a caster run whose baseline sim gives no spell damage fails', async () => {
		await expect(
			runSpec({
				pool: S_POOL,
				spec: 'mage',
				castDamage: null,
				computeStats: casterRead(5),
			}),
		).rejects.toThrow(/spell damage/);
	});

	it('school hit from talents gets no note, because the price already counts it', async () => {
		for (const [spec, slot, school] of [
			['mage', 6, SCHOOL.arcane],
			['shadow', 11, SCHOOL.shadow],
		] as const) {
			const run = await runSpec({
				pool: S_POOL,
				spec,
				skeleton: skeletonWithTalents('0--'),
				computeStats: casterRead(5, { [slot]: 10 }),
				castDamage: { [school]: 1 },
			});
			expect(run.ranking.substitutions.filter(isHitCapNote)).toEqual([]);
		}
	});

	it('a warlock with Suppression gets the note that names it', async () => {
		// Oracle: Suppression is a per-spell bonus on Affliction spells
		// (`sim/warlock/talents.go:75-84`), in no stats slot.
		const run = await runSpec({
			pool: S_POOL,
			spec: 'warlock',
			skeleton: skeletonWithTalents('5--'),
			computeStats: casterRead(5),
		});
		expect(run.ranking.substitutions.filter(isHitCapNote)).toEqual([
			{
				field: 'Meta gem swaps and the hit cap',
				detail: perSpellTalentDetail('Suppression'),
			},
		]);
	});

	it('a shadow priest with Focused Power gets the note that names it', async () => {
		// Oracle: Focused Power is a per-spell bonus on Smite and Mind Blast
		// (`sim/priest/talents.go:64-73`), Discipline (segment 0) index 15 in
		// `ui/sim/talents/trees/priest.json`.
		const run = await runSpec({
			pool: S_POOL,
			spec: 'shadow',
			skeleton: skeletonWithTalents('0000000000000002--'),
			computeStats: casterRead(5),
		});
		expect(run.ranking.substitutions.filter(isHitCapNote)).toEqual([
			{
				field: 'Meta gem swaps and the hit cap',
				detail: perSpellTalentDetail('Focused Power'),
			},
		]);
	});

	it('against a target that is not level 73 a caster gets only the no-cap note', async () => {
		// Oracle: with no budget, hit was treated as always useful; the
		// level-73 note says so, and no other hit-cap note joins it.
		const run = await runSpec({
			pool: S_POOL,
			spec: 'warlock',
			skeleton: skeletonAtLevel(72, skeletonWithTalents('5--')),
			computeStats: casterRead(5),
		});
		const notes = run.ranking.substitutions.filter(isHitCapNote);
		expect(notes).toHaveLength(1);
		expect(notes[0]!.detail).toMatch(/level 73/);
	});

	it('with no per-spell hit talent, a budget spec gets no hit-cap note', async () => {
		for (const spec of ['mage', 'shadow', 'warlock'] as const) {
			const run = await runSpec({
				pool: S_POOL,
				spec,
				skeleton: skeletonWithTalents('0--'),
				computeStats: casterRead(5),
			});
			expect(run.ranking.substitutions.filter(isHitCapNote)).toEqual([]);
		}
		const ret = await runSpec({
			pool: S_POOL,
			computeStats: gearHitReads(),
		});
		expect(ret.ranking.substitutions.filter(isHitCapNote)).toEqual([]);
	});
});
