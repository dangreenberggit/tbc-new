import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EligibleCount } from './EligibleCount';

loadEnglishBundles();

describe('EligibleCount', () => {
	it('gives the count in words, and as data for the gate scripts', () => {
		render(<EligibleCount count={523} />);
		const count = screen.getByTestId('upgrades-eligible-count');
		expect(count.textContent).toBe('523 eligible items');
		expect(count.dataset.count).toBe('523');
	});

	it('says so for a spec with no ranking data', () => {
		render(<EligibleCount count={undefined} />);
		const count = screen.getByTestId('upgrades-eligible-count');
		expect(count.textContent).toBe('No ranking data for this spec');
		expect(count.dataset.count).toBeUndefined();
	});
});
