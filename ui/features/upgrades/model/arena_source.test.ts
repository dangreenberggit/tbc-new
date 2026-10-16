import { describe, expect, it } from 'vitest';

import { poolFor } from './data/data';
import { effectivePool, sourceKeyOf } from './settings_pool';

// Fork-added. Ticket 642: arena gear is a source the player keeps or removes,
// not an exclusion. Every arena piece carries one `pvp`/`arena` source with
// its season, files under "PvP vendor", and unticking that source removes it.
const SEASON_BY_PREFIX: [string, number][] = [
	["Merciless Gladiator's ", 2],
	["Vengeful Gladiator's ", 3],
	["Brutal Gladiator's ", 4],
	["Gladiator's ", 1],
];
const seasonOf = (name: string): number | undefined => SEASON_BY_PREFIX.find(([prefix]) => name.startsWith(prefix))?.[1];

describe('arena gear in the ret phase-4 pool', () => {
	const pool = poolFor('ret', 4);
	const arena = pool.filter(e => seasonOf(e.name) !== undefined);

	it('holds the arena pieces of seasons 1-3', () => {
		// 56 = the completeness gate's E-arena count for ret-p4
		// (`python scripts/check_pool_completeness.py --report` in the main repo).
		expect(arena).toHaveLength(56);
		expect(new Set(arena.map(e => seasonOf(e.name)))).toEqual(new Set([1, 2, 3]));
	});

	it('gives each piece one pvp/arena source with its season', () => {
		for (const e of arena) {
			expect(e.source, `${e.itemId} ${e.name}`).toMatchObject({ kind: 'pvp', via: 'arena', season: seasonOf(e.name) });
		}
	});

	it('files every piece under "PvP vendor"', () => {
		expect(new Set(arena.map(sourceKeyOf))).toEqual(new Set(['PvP vendor']));
	});

	it('removes every piece when "PvP vendor" is unticked, and nothing else', () => {
		const kept = effectivePool(pool, { excludedSources: ['PvP vendor'], selectedSetItemIds: [], prune: false });
		const keptIds = new Set(kept.map(e => e.itemId));
		expect(arena.filter(e => keptIds.has(e.itemId))).toEqual([]);
		const otherPvp = pool.filter(e => seasonOf(e.name) === undefined && sourceKeyOf(e) === 'PvP vendor');
		expect(kept).toHaveLength(pool.length - arena.length - otherPvp.length);
	});
});
