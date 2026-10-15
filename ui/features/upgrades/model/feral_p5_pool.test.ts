import { describe, expect, it } from 'vitest';

import { poolFor } from './data/data';

// Fork-added. Tickets 609, 611, 612 and 500: the feral phase-5 list holds the
// Thunderheart Sunwell pieces (token route), the Sunmote upgrade 34397, and
// the Sunwell craft 34370 whose pattern drops in the raid.
describe('feral phase-5 pool', () => {
	const ids = new Set(poolFor('feral', 5).map(e => e.itemId));

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
