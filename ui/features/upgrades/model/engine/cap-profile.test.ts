import { describe, expect, it } from 'vitest';

import { CAP_PROFILE_BY_SPEC, capProfileFor, hitCapBudgetFrom, PHYSICAL_HIT_RATING_PER_HIT_PERCENT, SPELL_HIT_RATING_PER_HIT_PERCENT } from './cap-profile';
import { Stat } from './stats';
import type { SpecId } from './types';

/** A pseudo-stat array with indexes 12 (melee hit %) and 13 (spell hit %) set. */
function pseudoStats(hit: { melee?: number; spell?: number }): number[] {
	const out = new Array<number>(25).fill(0);
	out[12] = hit.melee ?? 0;
	out[13] = hit.spell ?? 0;
	return out;
}

function request(faerieFire: string | number | undefined, levels: readonly number[] = [73]) {
	return {
		raid: { debuffs: faerieFire === undefined ? {} : { faerieFire } },
		encounter: { targets: levels.map(level => ({ level })) },
	};
}

describe('meta repair hit policy per spec', () => {
	it('gives the note to rogue, enh, warrior, hunter, balance and ele and a budget to every other spec', () => {
		const specs = Object.keys(CAP_PROFILE_BY_SPEC) as SpecId[];
		const byKind = (kind: string) => specs.filter(s => CAP_PROFILE_BY_SPEC[s].repair.kind === kind).sort();
		expect(byKind('fullWeight')).toEqual(['balance', 'ele', 'enh', 'hunter', 'rogue', 'warrior']);
		expect(byKind('budget')).toEqual(['feral', 'mage', 'ret', 'shadow', 'warlock']);
	});

	it("charges a melee spec's hit against 9% minus Improved Faerie Fire, read from slot 12", () => {
		const budget = hitCapBudgetFrom(capProfileFor('ret'), request('TristateEffectImproved'), pseudoStats({ melee: 7, spell: 1 }));
		expect(budget?.stat).toBe(Stat.StatMeleeHitRating);
		expect(budget?.remaining).toBeCloseTo((9 - 3 - 7) * PHYSICAL_HIT_RATING_PER_HIT_PERCENT, 9);
	});

	it("charges a caster's hit against 16% read from slot 13, with no Faerie Fire term", () => {
		for (const spec of ['mage', 'shadow', 'warlock'] as const) {
			const budget = hitCapBudgetFrom(capProfileFor(spec), request('TristateEffectImproved'), pseudoStats({ melee: 2, spell: 10 }), { 32: 1 });
			expect(budget?.stat, spec).toBe(Stat.StatSpellHitRating);
			expect(budget?.remaining, spec).toBeCloseTo((16 - 10) * SPELL_HIT_RATING_PER_HIT_PERCENT, 9);
		}
	});

	it('gives a full-weight spec no budget even when both hit slots are read', () => {
		for (const spec of ['hunter', 'balance', 'ele'] as const) {
			expect(hitCapBudgetFrom(capProfileFor(spec), request('TristateEffectImproved'), pseudoStats({ melee: 5, spell: 5 })), spec).toBeUndefined();
		}
	});

	it('gives no budget when a target is not level 73', () => {
		for (const spec of ['ret', 'mage'] as const) {
			for (const levels of [[72], [73, 72]]) {
				expect(
					hitCapBudgetFrom(capProfileFor(spec), request(undefined, levels), pseudoStats({ melee: 5, spell: 5 })),
					`${spec} ${levels.join(',')}`,
				).toBeUndefined();
			}
		}
	});
});

/** ret's worn P3 gear's `meleeHitPercent_final` against level 73 with no set bonus, as the sim read it. */
const RET_BASELINE_HIT_PERCENT = 6.297560509125587;

describe('repair hit budget', () => {
	it('ret with Improved Faerie Fire and one level-73 target is 4.69 rating over the cap', () => {
		// 52 rating is 3.30% hit plus Precision's 3%; the cap with Improved
		// Faerie Fire is 6%, 47.31 rating after Precision.
		const budget = hitCapBudgetFrom(capProfileFor('ret'), request('TristateEffectImproved'), pseudoStats({ melee: RET_BASELINE_HIT_PERCENT }));
		expect(budget?.stat).toBe(Stat.StatMeleeHitRating);
		expect(budget?.remaining).toBeCloseTo(-4.69, 2);
	});

	it("without Improved Faerie Fire the budget is the readout's cap minus the gear and Precision", () => {
		// 141.92 (the readout's hit cap rating) − 52 − 47.31 = 42.62.
		for (const ff of [undefined, 'TristateEffectRegular']) {
			const budget = hitCapBudgetFrom(capProfileFor('ret'), request(ff), pseudoStats({ melee: RET_BASELINE_HIT_PERCENT }));
			expect(budget?.remaining).toBeCloseTo(42.62, 2);
		}
	});

	it("the debuff's enum value 2 counts as Improved", () => {
		const budget = hitCapBudgetFrom(capProfileFor('ret'), request(2), pseudoStats({ melee: RET_BASELINE_HIT_PERCENT }));
		expect(budget?.remaining).toBeCloseTo(-4.69, 2);
	});
});

/** The sim's `SpellSchool` bits (`sim/core/flags.go:226-232`). */
const SCHOOL = { fire: 4, shadow: 32, arcane: 64 } as const;
const SPELL_HIT_RATING_PER_PERCENT = 12.615385;

describe("a caster's hit is priced by the spells its sim cast", () => {
	/** A slot-13 read of 5% whose Shadow slot, 11, reads 15%. */
	const shadowFocusRead = () => {
		const pseudo = pseudoStats({ spell: 5 });
		for (let slot = 6; slot <= 11; slot++) pseudo[slot] = 5;
		pseudo[11] = 15;
		return pseudo;
	};

	it('the budget splits the spell damage by school, each school capped at its own hit', () => {
		// Oracle: Shadow spells read slot 11, 10% (126.15 rating) above slot
		// 13; Arcane spells read slot 6, equal to slot 13.
		const budget = hitCapBudgetFrom(capProfileFor('shadow'), request(undefined), shadowFocusRead(), { [SCHOOL.shadow]: 900, [SCHOOL.arcane]: 100 });
		expect(budget?.remaining).toBeCloseTo(11 * SPELL_HIT_RATING_PER_PERCENT, 6);
		expect(budget?.groups).toEqual([
			{ offset: 0, share: 0.1 },
			{ offset: expect.closeTo(10 * SPELL_HIT_RATING_PER_PERCENT, 6), share: 0.9 },
		]);
	});

	it('physical damage takes no share, and a two-school spell reads slot 13', () => {
		// Oracle: `SchoolIndex` sends a multi-school spell to the physical
		// index, which holds no school hit (`sim/core/flags.go:288-308`), so
		// its hit is slot 13's; physical damage uses melee hit, not spell hit.
		const budget = hitCapBudgetFrom(capProfileFor('shadow'), request(undefined), shadowFocusRead(), {
			1: 500,
			[SCHOOL.shadow + SCHOOL.fire]: 250,
			[SCHOOL.shadow]: 750,
		});
		expect(budget?.groups).toEqual([
			{ offset: 0, share: 0.25 },
			{ offset: expect.closeTo(10 * SPELL_HIT_RATING_PER_PERCENT, 6), share: 0.75 },
		]);
	});

	it('a melee budget takes no groups; a spell budget with no spell damage throws', () => {
		const melee = hitCapBudgetFrom(capProfileFor('ret'), request(undefined), pseudoStats({ melee: 5 }), { [SCHOOL.shadow]: 1 });
		expect(melee?.groups).toBeUndefined();
		expect(() => hitCapBudgetFrom(capProfileFor('mage'), request(undefined), shadowFocusRead())).toThrow(/spell damage/);
	});
});
