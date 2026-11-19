import { describe, expect, it } from 'vitest';

import { shownTenths } from './shown_figure';

// A figure below the ranking's cutoff must not read as the cutoff ("+3.0" for 2.96 against a 3 DPS cutoff).
describe('shownTenths', () => {
	it('shows a positive figure below the cutoff one tenth under the cutoff when rounding would reach it', () => {
		expect(shownTenths(2.96, 3)).toBe(29);
		expect(shownTenths(2.999, 3)).toBe(29);
		expect(shownTenths(2.95, 3)).toBe(29);
	});

	it('rounds as usual everywhere else', () => {
		expect(shownTenths(2.94, 3)).toBe(29);
		expect(shownTenths(3.0, 3)).toBe(30);
		expect(shownTenths(3.04, 3)).toBe(30);
		expect(shownTenths(2.96)).toBe(30);
		expect(shownTenths(-2.96, 3)).toBe(-30);
		expect(shownTenths(22.8, 3)).toBe(228);
	});

	it('works against a cutoff that is not a whole number', () => {
		expect(shownTenths(0.26, 0.3)).toBe(2);
	});
});
