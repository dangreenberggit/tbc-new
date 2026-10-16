import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NO_VIEW_TOGGLES, type ViewSourceOptions } from '../../model/results_view';
import { ViewToggles, type ViewTogglesProps } from './ViewToggles';

loadEnglishBundles();

const BOTH = { withSetPotential: true, onlyBis: true };
const NO_SOURCES: ViewTogglesProps['sources'] = { options: { raids: [], other: [] }, hidden: [], onToggle: vi.fn(), onSetAll: vi.fn() };
const BLACK_TEMPLE: ViewSourceOptions = { raids: [{ key: 'Black Temple', count: 2 }], other: [] };

describe('ViewToggles', () => {
	it('renders nothing when the run offers no toggle', () => {
		expect(
			render(<ViewToggles offered={NO_VIEW_TOGGLES} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={vi.fn()} sources={NO_SOURCES} />).container
				.innerHTML,
		).toBe('');
	});

	it('shows only the toggles on offer, each checked as set', () => {
		const { getByTestId, queryByTestId } = render(
			<ViewToggles offered={{ withSetPotential: true, onlyBis: false }} toggles={BOTH} maxPhase={3} onChange={vi.fn()} sources={NO_SOURCES} />,
		);
		expect(within(getByTestId('upgrades-view-set-potential')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
		expect(queryByTestId('upgrades-view-only-bis')).toBeNull();
	});

	it('reports which toggle changed', () => {
		const onChange = vi.fn();
		const { getByTestId } = render(<ViewToggles offered={BOTH} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={onChange} sources={NO_SOURCES} />);
		fireEvent.click(within(getByTestId('upgrades-view-only-bis')).getByRole('checkbox'));
		expect(onChange).toHaveBeenCalledWith('onlyBis', true);
	});

	it('offers Filter by source after the toggles when the table has a source to filter', () => {
		const { getByTestId, queryByTestId } = render(
			<ViewToggles offered={BOTH} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={vi.fn()} sources={{ ...NO_SOURCES, options: BLACK_TEMPLE }} />,
		);
		const controls = [...getByTestId('upgrades-view-toggles').querySelectorAll('[data-testid]')].map(element => element.getAttribute('data-testid'));
		expect(controls.filter(id => id?.startsWith('upgrades-view-'))).toEqual([
			'upgrades-view-set-potential',
			'upgrades-view-only-bis',
			'upgrades-view-sources-button',
			'upgrades-view-sources-summary',
		]);
		expect(queryByTestId('upgrades-view-sources-button')?.textContent).toBe('Filter by source');
	});

	it('shows only Filter by source when the run offers no toggle but the table has sources', () => {
		const { getByTestId, queryByTestId } = render(
			<ViewToggles
				offered={NO_VIEW_TOGGLES}
				toggles={NO_VIEW_TOGGLES}
				maxPhase={3}
				onChange={vi.fn()}
				sources={{ ...NO_SOURCES, options: BLACK_TEMPLE }}
			/>,
		);
		expect(getByTestId('upgrades-view-sources-button')).not.toBeNull();
		expect(queryByTestId('upgrades-view-set-potential')).toBeNull();
		expect(queryByTestId('upgrades-view-only-bis')).toBeNull();
	});

	it('leaves Filter by source out when the table has no source to filter', () => {
		const { queryByTestId } = render(<ViewToggles offered={BOTH} toggles={NO_VIEW_TOGGLES} maxPhase={3} onChange={vi.fn()} sources={NO_SOURCES} />);
		expect(queryByTestId('upgrades-view-sources-button')).toBeNull();
	});
});
