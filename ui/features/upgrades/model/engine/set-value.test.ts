import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isBonusImplemented, netInflation } from './set-value';

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
			db.items
				.map(i => i.setId)
				.filter((setId): setId is number => setId !== undefined && (isBonusImplemented(setId, 2) || isBonusImplemented(setId, 4))),
		);
		expect(implemented.size).toBeGreaterThan(0);
		const twoSlot = db.items.filter(i => i.setId !== undefined && implemented.has(i.setId) && (i.type === 11 || i.type === 12));
		expect(twoSlot).toEqual([]);
	});
});
