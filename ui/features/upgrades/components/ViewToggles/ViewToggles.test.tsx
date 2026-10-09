import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NO_VIEW_TOGGLES } from '../../model/results_view';
import { ViewToggles } from './ViewToggles';

loadEnglishBundles();

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
