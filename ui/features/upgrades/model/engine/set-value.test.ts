import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { HANDS_SLOT, LEGS_SLOT, THUNDERHEART } from '../../testing/set_bonus_scenario';
import type { PoolEntry } from './pool';
import { isBonusImplemented, netInflation, selectAddedPieces, SET_THRESHOLDS } from './set-value';
import { SIM_ORDER } from './slots';

// `selectAddedPieces` reads set ids through `Database.getSync()`; the real class over the test database stands in for the page's.
vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const DB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../assets/database/db.json');

describe('netInflation', () => {
	it("adds back a break only the 2pc package's end state has", () => {
		// A model, not the formula: a 4pc package worth 60, whose 2pc package's
		// end state breaks a worn bonus worth 40 that the 4pc package's end state
		// keeps, and no member single breaks it. The pieces' own stats are 500
		// and the 2pc bonus is 30. `computeBonusDps` gives pkgΔ − Σsingles − raw2pc.
		// The 2pc package's Δ is its pieces' stats plus 30 minus the 40 its end
		// state breaks, so its raw synergy over its singles is 30 − 40.
		const pieces = 500;
		const bonus2 = 30;
		const bonus4 = 60;
		const broken = 40;
		const pkgDelta = pieces + bonus2 + bonus4;
		const singles = pieces;
		const raw2pc = bonus2 - broken;
		const raw = pkgDelta - singles - raw2pc;
		const inflation = netInflation([
			{
				piecesBreakingAlone: 0,
				twoPcPiecesBreakingAlone: 0,
				allPiecesBreak: 0,
				allTwoPcPiecesBreak: 1,
				brokenBonusDps: broken,
			},
		]);
		expect(raw).toBe(100);
		expect(raw - inflation).toBe(bonus4);
	});

	// The models below are a 2pc package of two pieces worth 250 each with a 2pc bonus of 30,
	// or a 4pc package of four pieces worth 125 each (the 2pc package is its first two) with
	// a 4pc bonus of 60. The worn bonus they may break, of another set, is worth 40.
	// `computeBonusDps` gives pkgΔ − Σsingles for the 2pc and pkgΔ − Σsingles − raw2pc for
	// the 4pc.
	const broken = 40;

	it('takes back a break the whole package has but no single piece has', () => {
		// Three worn pieces of another set: each piece alone leaves two (its 2pc holds),
		// both together leave one (its 2pc breaks).
		const pkgDelta = 500 + 30 - broken;
		const singles = 500;
		const raw = pkgDelta - singles;
		const inflation = netInflation([
			{ piecesBreakingAlone: 0, twoPcPiecesBreakingAlone: 0, allPiecesBreak: 1, allTwoPcPiecesBreak: 0, brokenBonusDps: broken },
		]);
		expect(raw).toBe(-10);
		expect(raw - inflation).toBe(30);
	});

	it('adds back the break each piece has alone', () => {
		// Two worn pieces of another set, one in each piece's slot: each piece alone breaks
		// its 2pc, and so do both together.
		const pkgDelta = 500 + 30 - broken;
		const singles = 500 - 2 * broken;
		const raw = pkgDelta - singles;
		const inflation = netInflation([
			{ piecesBreakingAlone: 2, twoPcPiecesBreakingAlone: 0, allPiecesBreak: 1, allTwoPcPiecesBreak: 0, brokenBonusDps: broken },
		]);
		expect(raw).toBe(70);
		expect(raw - inflation).toBe(30);
	});

	it("takes back the break a 2pc piece has alone, which the 4pc's raw 2pc already paid", () => {
		// Two worn pieces of another set, in the slots of the 4pc package's first and third
		// pieces: those two each break its 2pc alone, and the 2pc package (first and second)
		// and the 4pc package break it too.
		const pkgDelta4 = 500 + 30 + 60 - broken;
		const singles4 = 500 - 2 * broken;
		const raw2pc = 250 + 30 - broken - (250 - broken);
		const raw = pkgDelta4 - singles4 - raw2pc;
		const inflation = netInflation([
			{ piecesBreakingAlone: 2, twoPcPiecesBreakingAlone: 1, allPiecesBreak: 1, allTwoPcPiecesBreak: 1, brokenBonusDps: broken },
		]);
		expect(raw).toBe(100);
		expect(raw - inflation).toBe(60);
	});
});

describe('selectAddedPieces', () => {
	const entry = ([itemId, slot]: readonly [number, PoolEntry['slot']]): PoolEntry => ({
		itemId,
		name: String(itemId),
		slot,
		phase: 1,
		source: { kind: 'unknown' },
	});
	const slotOf = new Map<number, number>([
		[THUNDERHEART.hands, HANDS_SLOT],
		[THUNDERHEART.legs, LEGS_SLOT],
		[THUNDERHEART.chest, SIM_ORDER.indexOf('chest')],
	]);

	it('adds no piece to a slot that already holds a worn piece of the set, even its best gain', () => {
		const equipment = SIM_ORDER.map((_, i) => ({ id: i === HANDS_SLOT ? THUNDERHEART.hands : 0, gems: [] }));
		const ownDeltas = [THUNDERHEART.hands, THUNDERHEART.legs, THUNDERHEART.chest].map((itemId, i) => ({
			itemId,
			slotIndex: slotOf.get(itemId)!,
			deltaDps: [30, 20, 10][i]!,
			se: 0,
		}));
		const pool = (
			[
				[THUNDERHEART.hands, 'hands'],
				[THUNDERHEART.legs, 'legs'],
				[THUNDERHEART.chest, 'chest'],
			] as const
		).map(entry);
		const result = selectAddedPieces(676, 2, equipment, pool, ownDeltas, e => slotOf.get(e.itemId));
		expect(result).toEqual({ ok: true, piecesWorn: 1, addedPieces: [{ itemId: THUNDERHEART.legs, slotIndex: LEGS_SLOT }] });
		// Three more for the 4pc while two other slots are open: not enough.
		expect(selectAddedPieces(676, 4, equipment, pool, ownDeltas, e => slotOf.get(e.itemId))).toEqual({ ok: false, reason: 'insufficient-pieces' });
	});
});

describe('isBonusImplemented', () => {
	it('no member of a set with an implemented bonus is a ring or trinket', () => {
		// The set-value math assumes a set piece never has two candidate slots. That
		// holds because no member of a set with a bonus implemented in the sim is a
		// two-slot item type (11 finger, 12 trinket). This pins it.
		const db = JSON.parse(readFileSync(DB_PATH, 'utf8')) as {
			items: Array<{ id: number; type: number; setId?: number }>;
		};
		// Asked of the engine so a set added to its table is covered too; an
		// empty set would make the check below pass vacuously.
		const implemented = new Set(
			db.items.map(i => i.setId).filter((setId): setId is number => setId !== undefined && SET_THRESHOLDS.some(t => isBonusImplemented(setId, t))),
		);
		expect(implemented.size).toBeGreaterThan(0);
		const twoSlot = db.items.filter(i => i.setId !== undefined && implemented.has(i.setId) && (i.type === 11 || i.type === 12));
		expect(twoSlot).toEqual([]);
	});
});
