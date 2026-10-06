import i18n from '@i18n/config';
import { render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishCharacter from '../../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../../assets/locales/en/translation.json';
import { fixtureRow } from '../../testing/ranking_fixture';

vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultsPane } = await import('./ResultsPane');

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const CONTEXT = { itemOf: () => undefined, tip: {} };
const onSort = () => {};

describe('ResultsPane', () => {
	it('shows the shortlist in a sortable table and the rest in a collapsed group', () => {
		const { getAllByTestId, getByTestId } = render(
			<ResultsPane shortlist={[fixtureRow(0), fixtureRow(1)]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} onSort={onSort} />,
		);

		expect(getAllByTestId('upgrades-results-table')).toHaveLength(1);
		expect(within(getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row')).toHaveLength(2);
		expect(getByTestId('upgrades-sort-item')).not.toBeNull();
		expect(getByTestId('upgrades-below-cutoff-trigger').textContent).toBe('1 item(s) below the cutoff');
	});

	it('has no group when every row cleared the cutoff', () => {
		const { queryByTestId } = render(<ResultsPane shortlist={[fixtureRow(0)]} belowCutoff={[]} rowContext={CONTEXT} onSort={onSort} />);
		expect(queryByTestId('upgrades-below-cutoff')).toBeNull();
	});

	it('says no row cleared the cutoff in place of an empty table', () => {
		const { getByTestId, queryByTestId } = render(<ResultsPane shortlist={[]} belowCutoff={[fixtureRow(5)]} rowContext={CONTEXT} onSort={onSort} />);

		expect(queryByTestId('upgrades-results-table')).toBeNull();
		expect(getByTestId('upgrades-empty-state').textContent).toContain('No upgrades found');
		expect(getByTestId('upgrades-below-cutoff')).not.toBeNull();
	});
});
