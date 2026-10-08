import i18n from '@i18n/config';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../../assets/locales/en/upgrades.json';
import { EligibleCount } from './EligibleCount';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
beforeAll(() => i18n.addResourceBundle('en', 'upgrades', upgradesTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterAll(() => i18n.removeResourceBundle('en', 'upgrades'));

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
