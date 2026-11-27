import { describe, expect, it, vi } from 'vitest';

import {
	CAPPED_CHESTS,
	CHEST,
	RAGESTEEL_BREASTPLATE,
	RAGESTEEL_SHOULDERS,
	retInputs,
	retWeights,
	SHOULDER,
	UNCAPPED_CHESTS,
} from '../../testing/meta_repair_inputs';
import { gearHitRating } from './caps';
import { candidateSwapWithRepairs } from './gear-swap';
import { Stat } from './stats';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

describe('gear hit matches the sim', () => {
	it("ret's worn P3 gear sums to the sim's 52 gear hit rating, head enchant included", () => {
		const { equipment } = retInputs();
		expect(retWeights['20']).toBe(2.15);
		expect(retWeights['0']).toBe(1.0);
		expect(gearHitRating(equipment, Stat.StatMeleeHitRating)).toBe(52);
	});

	it("each chest candidate's as-built gear sums to the sim's reading of it", () => {
		const { equipment, gems } = retInputs();
		const asBuilt = (itemId: number) => gearHitRating(candidateSwapWithRepairs(equipment, CHEST, itemId, gems).equipment, Stat.StatMeleeHitRating);
		for (const { itemId, asBuilt: rating } of CAPPED_CHESTS) {
			expect([itemId, asBuilt(itemId)]).toEqual([itemId, rating]);
		}
		for (const itemId of UNCAPPED_CHESTS) {
			expect([itemId, asBuilt(itemId)]).toEqual([itemId, 45]);
		}
	});

	it('the Burning Rage package sums to the set-less reading, 54; the set-kept 74 is out of reach because set-bonus hit is in Go code', () => {
		const { equipment, gems } = retInputs();
		const shoulders = candidateSwapWithRepairs(equipment, SHOULDER, RAGESTEEL_SHOULDERS, gems).equipment;
		const pkg = candidateSwapWithRepairs(shoulders, CHEST, RAGESTEEL_BREASTPLATE, gems).equipment;
		expect(gearHitRating(pkg, Stat.StatMeleeHitRating)).toBe(54);
	});
});
