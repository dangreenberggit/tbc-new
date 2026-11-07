import { getTalentTreePoints } from '@sim/proto/utils';
import { describe, expect, it } from 'vitest';

import { epWeightsSetFor } from './data';

describe('epWeightsSetFor', () => {
	// A page with no talents yet, or a talents string with no points, must not count as Arms or Survival: the variant
	// tree has to lead with at least one point (review finding A1 of feat/452-survival-arms).
	it.each([
		['no trees', []],
		['an empty talents string', getTalentTreePoints('')],
		['three empty trees', [0, 0, 0]],
		['a tie between the variant tree and another', [30, 30, 1]],
	])('keeps the spec’s own set for %s', (_case, points) => {
		expect(epWeightsSetFor('warrior', points)).toBe('warrior');
		expect(epWeightsSetFor('hunter', [...points].reverse())).toBe('hunter');
	});

	it('takes the variant set when its tree has strictly the most points', () => {
		expect(epWeightsSetFor('warrior', [33, 28, 0])).toBe('warrior-arms');
		expect(epWeightsSetFor('hunter', [7, 20, 34])).toBe('hunter-sv');
	});
});
