import { getTalentTreePoints } from '@sim/proto/utils';
import { describe, expect, it } from 'vitest';

import { epWeightsPresetFor } from './data';

describe('epWeightsPresetFor', () => {
	// A page with no talents yet, or a talents string with no points, must not count as Arms or Survival: the variant
	// tree has to lead with at least one point.
	it.each([
		['no trees', []],
		['an empty talents string', getTalentTreePoints('')],
		['three empty trees', [0, 0, 0]],
		['a tie between the variant tree and another', [30, 30, 1]],
	])('keeps the spec’s own set for %s', (_case, points) => {
		expect(epWeightsPresetFor('warrior', points)).toBe('warrior');
		expect(epWeightsPresetFor('hunter', [...points].reverse())).toBe('hunter');
	});

	it('takes the variant set when its tree has strictly the most points', () => {
		expect(epWeightsPresetFor('warrior', [33, 28, 0])).toBe('warrior-arms');
		expect(epWeightsPresetFor('hunter', [7, 20, 34])).toBe('hunter-sv');
	});
});
