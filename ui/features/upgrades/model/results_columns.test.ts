import { describe, expect, it } from 'vitest';

import { fixtureRow } from '../testing/ranking_fixture';
import { compareSortValues, sortValue } from './results_columns';

// Torch of the Damned (weapon, Black Temple).
const TORCH = fixtureRow(0);
const LABELS = { slot: () => 'Main Hand', source: () => 'Black Temple' };

describe('sortValue', () => {
	it('sorts names, slots and sources on their lower-cased text', () => {
		expect(sortValue('item', TORCH, LABELS, undefined)).toBe('torch of the damned');
		expect(sortValue('slot', TORCH, LABELS, undefined)).toBe('main hand');
		expect(sortValue('source', TORCH, LABELS, undefined)).toBe('black temple');
	});

	it('sorts ΔDPS on the bare ΔDPS, or on the key the view gives', () => {
		expect(sortValue('delta_dps', TORCH, LABELS, undefined)).toBe(TORCH.deltaDps);
		expect(sortValue('delta_dps', TORCH, LABELS, () => 99)).toBe(99);
	});
});

describe('compareSortValues', () => {
	it('orders text and numbers with plain comparison, and calls equal values a tie', () => {
		expect(compareSortValues('a', 'b')).toBe(-1);
		expect(compareSortValues('b', 'a')).toBe(1);
		expect(compareSortValues('item 10', 'item 9')).toBe(-1);
		expect(compareSortValues(2, 10)).toBe(-1);
		expect(compareSortValues('a', 'a')).toBe(0);
	});
});
