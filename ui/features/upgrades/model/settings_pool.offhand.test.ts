import { describe, expect, it, vi } from 'vitest';

import { testItem } from '../testing/db_pool';
import type { PoolEntry } from './engine/pool';
import { eligibleCount } from './settings_pool';

// The engine reads hand types through the page's database; the test database stands in for it.
vi.mock('@sim/proto/database', () => ({ Database: { getSync: () => ({ getItemById: (id: number) => testItem(id) }) } }));

const weapon = (itemId: number): PoolEntry => ({ itemId, name: `item ${itemId}`, slot: 'weapon', phase: 3, source: { kind: 'raid', zone: 'Black Temple' } });

const HELD = [32361, 28734, 30911]; // Blind-Seers Icon, Jewel of Infinite Possibilities, Scepter of Purification: off hand only
const ONE_HANDER = 28524; // Emerald Ripper
const TWO_HANDER = 29988; // The Nexus Key
const POOL = [...HELD, ONE_HANDER, TWO_HANDER].map(weapon);

describe('eligibleCount and the worn main hand', () => {
	it('leaves out the off-hand-only items while a two-hander is worn, as a run does', () => {
		expect(eligibleCount(POOL, 3, { spec: 'mage', wornMainHandId: TWO_HANDER })).toBe(POOL.length - HELD.length);
	});

	it('counts them beside a one-hander or an empty main hand', () => {
		expect(eligibleCount(POOL, 3, { spec: 'mage', wornMainHandId: ONE_HANDER })).toBe(POOL.length);
		expect(eligibleCount(POOL, 3, { spec: 'mage', wornMainHandId: undefined })).toBe(POOL.length);
	});
});
