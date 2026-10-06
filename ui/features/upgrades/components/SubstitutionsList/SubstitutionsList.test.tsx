import i18n from '@i18n/config';
import { render, screen, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { RANKING_FIXTURE } from '../../testing/ranking_fixture';
import { SubstitutionsList } from './SubstitutionsList';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));

describe('SubstitutionsList', () => {
	it('lists each dropped candidate with the first line of the reason the engine gave', () => {
		render(<SubstitutionsList substitutions={RANKING_FIXTURE.substitutions} />);

		expect(screen.getByText(`Dropped candidates and substitutions (${RANKING_FIXTURE.substitutions.length})`)).toBeTruthy();
		const list = screen.getByTestId('upgrades-substitutions');
		expect(
			within(list)
				.getAllByRole('term')
				.map(term => term.textContent),
		).toEqual(['candidate 32837 (mainhand)']);
		expect(
			within(list)
				.getAllByRole('definition')
				.map(definition => definition.textContent),
		).toEqual([
			'Warglaive of Azzinoth was dropped from the ranking: the sim failed on this swap — panic: runtime error… (full text in the browser console)',
		]);
	});

	it('cuts a trace whose line breaks are written out as backslash-n', () => {
		render(
			<SubstitutionsList
				substitutions={[{ field: 'candidate 30900', detail: 'sim panicked: index out of range\ngoroutine 1 [running]:\nmain.go:12' }]}
			/>,
		);
		expect(within(screen.getByTestId('upgrades-substitutions')).getByRole('definition').textContent).toBe(
			'sim panicked: index out of range… (full text in the browser console)',
		);
	});

	it('leaves a one-line reason whole', () => {
		render(<SubstitutionsList substitutions={[{ field: 'hit cap', detail: 'Kept the worn hit gems.' }]} />);
		expect(within(screen.getByTestId('upgrades-substitutions')).getByRole('definition').textContent).toBe('Kept the worn hit gems.');
	});
});
