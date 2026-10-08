import i18n from '@i18n/config';
import { fireEvent, render, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import englishTranslations from '../../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../../assets/locales/en/upgrades.json';
import { NO_VIEW_TOGGLES } from '../../model/results_view';
import { ViewToggles } from './ViewToggles';

beforeAll(() => i18n.addResourceBundle('en', 'translation', englishTranslations, true, true));
beforeAll(() => i18n.addResourceBundle('en', 'upgrades', upgradesTranslations, true, true));
afterAll(() => i18n.removeResourceBundle('en', 'translation'));
afterAll(() => i18n.removeResourceBundle('en', 'upgrades'));

const BOTH = { withSetPotential: true, onlyBis: true };

describe('ViewToggles', () => {
	it('renders nothing when the run offers no toggle', () => {
		expect(render(<ViewToggles offered={NO_VIEW_TOGGLES} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={vi.fn()} />).container.innerHTML).toBe('');
	});

	it('shows only the toggles on offer, each checked as set', () => {
		const { getByTestId, queryByTestId } = render(
			<ViewToggles offered={{ withSetPotential: true, onlyBis: false }} toggles={BOTH} maxPhase={3} onChange={vi.fn()} />,
		);
		expect(within(getByTestId('upgrades-view-set-potential')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
		expect(queryByTestId('upgrades-view-only-bis')).toBeNull();
	});

	it('reports which toggle changed', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ViewToggles offered={BOTH} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={onChange} />);
		fireEvent.click(within(getByTestId('upgrades-view-only-bis')).getByRole('checkbox'));
		expect(onChange).toHaveBeenCalledWith('onlyBis', true);
	});
});
