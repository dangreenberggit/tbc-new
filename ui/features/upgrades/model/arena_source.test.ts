import { isPVPItem } from '@sim/proto/items';
import { describe, expect, it } from 'vitest';

import { dbPoolFor, testItem } from '../testing/db_pool';
import { effectivePool, sourceKeyOf } from './settings_pool';

// Fork-added. Ticket 642: arena gear is a source the player keeps or removes,
// not an exclusion. Every arena piece (upstream's `isPVPItem`) carries one
// `pvp`/`arena` source, files under "PvP vendor", and unticking that source
// removes it. wowsims states no TBC arena season, so the source names none;
// the season prefixes below only check which seasons the pool holds.
const SEASON_BY_PREFIX: [string, number][] = [
	["Merciless Gladiator's ", 2],
	["Vengeful Gladiator's ", 3],
	["Brutal Gladiator's ", 4],
	["Gladiator's ", 1],
];
const seasonOf = (name: string): number | undefined => SEASON_BY_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1];

// The ret phase-4 pool's arena pieces, counted over the fork's db.json by this test; the bundled list the run-time
// pool replaced (ticket 505) held 56.
const ARENA_PIECES = 78;

describe('arena gear in the ret phase-4 pool', () => {
	const pool = dbPoolFor('ret', 4);
	const arena = pool.filter(e => isPVPItem(testItem(e.itemId)!));

	it('holds the arena pieces of seasons 1-3', () => {
		expect(arena).toHaveLength(ARENA_PIECES);
		expect(new Set(arena.map(e => seasonOf(e.name)))).toEqual(new Set([1, 2, 3]));
	});

	it('gives each piece one pvp/arena source with no season', () => {
		for (const e of arena) expect(e.sources, `${e.itemId} ${e.name}`).toEqual([{ kind: 'pvp', via: 'arena' }]);
	});

	it('files every piece under "PvP vendor", and nothing else', () => {
		expect(new Set(arena.map(sourceKeyOf))).toEqual(new Set(['PvP vendor']));
		expect(pool.filter(e => sourceKeyOf(e) === 'PvP vendor')).toHaveLength(arena.length);
	});

	it('removes every piece when "PvP vendor" is unticked, and nothing else', () => {
		const kept = effectivePool(pool, { excludedSources: ['PvP vendor'], selectedSetItemIds: [], prune: false });
		const keptIds = new Set(kept.map(e => e.itemId));
		expect(arena.filter(e => keptIds.has(e.itemId))).toEqual([]);
		expect(kept).toHaveLength(pool.length - arena.length);
	});
});
