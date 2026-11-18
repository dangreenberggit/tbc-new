import { describe, expect, it } from 'vitest';

import { dbPoolFor } from '../testing/db_pool';

// The feral phase-5 pool holds the Thunderheart Sunwell pieces (token route),
// the Sunmote upgrade 34397, and the Sunwell craft 34370 whose pattern drops in
// the raid.
describe('feral phase-5 pool', () => {
	const ids = new Set(dbPoolFor('feral', 5).map(e => e.itemId));

	it.each([
		[34444, 'Thunderheart Wristguards'],
		[34556, 'Thunderheart Waistguard'],
		[34573, 'Thunderheart Treads'],
		[34397, 'Bladed Chaos Tunic'],
		[34370, 'Gloves of Immortal Dusk'],
	])('contains %i (%s)', id => {
		expect(ids.has(id)).toBe(true);
	});
});
