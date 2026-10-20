import { describe, expect, it } from 'vitest';

import { dbPoolHost, TEST_PRESETS } from '../testing/db_pool';
import type { SpecId } from './engine/types';
import { setOptions } from './settings_pool';

// Hunter and warrior list each (phase, name) twice, once per wowsims `group` (ticket 690). A shared key made React
// reuse one chip for both twins, so ticking one ticked the other.
const PRESET_COUNTS: Partial<Record<SpecId, number>> = { hunter: 31, warrior: 12 };

describe('preset set keys', () => {
	it.each(Object.keys(TEST_PRESETS) as SpecId[])('are unique over every preset %s offers', spec => {
		const presets = dbPoolHost(spec).individualConfig.presets.gear;
		const keys = setOptions({ presets, savedSets: [], pool: [] }).map(o => o.key);
		expect(new Set(keys).size).toBe(presets.length);
		if (PRESET_COUNTS[spec] !== undefined) expect(keys).toHaveLength(PRESET_COUNTS[spec]);
	});
});
