import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ViewSourceOptions } from '../../model/results_view';
import { ViewSourcesButton } from './ViewSourcesButton';

loadEnglishBundles();

const OPTIONS: ViewSourceOptions = {
	raids: [
		{ key: 'Black Temple', count: 3 },
		{ key: 'Hyjal Summit', count: 2 },
	],
	other: [
		{ key: 'Badge vendor', count: 1 },
		{ key: 'Crafted', count: 1 },
	],
};

/** A stand-in for the tab store: it keeps the hidden sources, so the dialog shows what a click changed. */
const Harness = ({ initial = [] }: { initial?: readonly string[] }) => {
	const [hidden, setHidden] = useState<readonly string[]>(initial);
	const onToggle = (key: string) => setHidden(keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]));
	return <ViewSourcesButton options={OPTIONS} hidden={hidden} onToggle={onToggle} onSetAll={setHidden} />;
};

const summary = () => screen.getByTestId('upgrades-view-sources-summary').textContent;
const open = () => fireEvent.click(screen.getByTestId('upgrades-view-sources-button'));
const box = (key: string) => {
	const found = screen.getAllByTestId('upgrades-view-source-row').find(element => element.dataset.source === key);
	if (!found) throw new Error(`no source row ${key}`);
	return within(found).getByRole('checkbox');
};
const ticked = () =>
	within(screen.getByTestId('upgrades-view-sources-dialog'))
		.getAllByRole('checkbox')
		.map(checkbox => checkbox.getAttribute('aria-checked'));

describe('ViewSourcesButton', () => {
	it('opens a dialog titled for what it does, with raids and other sources in two groups, every source ticked', () => {
		render(<Harness />);
		expect(screen.getByTestId('upgrades-view-sources-button').textContent).toBe('Filter by source');
		expect(summary()).toBe('Showing all sources');
		open();

		const dialog = screen.getByTestId('upgrades-view-sources-dialog');
		expect(within(dialog).getByTestId('sim-dialog-title').textContent).toBe('Filter by source');
		expect([...dialog.querySelectorAll('legend')].map(legend => legend.textContent)).toEqual(['Raids and dungeons', 'Other sources']);
		expect(screen.getAllByTestId('upgrades-view-source-row').map(element => element.dataset.source)).toEqual([
			'Black Temple',
			'Hyjal Summit',
			'Badge vendor',
			'Crafted',
		]);
		expect(ticked()).toEqual(['true', 'true', 'true', 'true']);
	});

	it('hides an unticked source and counts it in the summary', () => {
		render(<Harness />);
		open();
		fireEvent.click(box('Hyjal Summit'));
		fireEvent.click(box('Crafted'));

		expect(box('Hyjal Summit').getAttribute('aria-checked')).toBe('false');
		expect(summary()).toBe('2 of 4 sources hidden');
	});

	it('reports the toggled source', () => {
		const onToggle = vi.fn();
		render(<ViewSourcesButton options={OPTIONS} hidden={[]} onToggle={onToggle} onSetAll={vi.fn()} />);
		open();
		fireEvent.click(box('Badge vendor'));
		expect(onToggle).toHaveBeenCalledWith('Badge vendor');
	});

	it('hides every offered source with Hide all and shows them again with Show all', () => {
		const onSetAll = vi.fn();
		render(<ViewSourcesButton options={OPTIONS} hidden={['Karazhan']} onToggle={vi.fn()} onSetAll={onSetAll} />);
		open();
		fireEvent.click(screen.getByTestId('upgrades-view-sources-hide-all'));
		expect(onSetAll).toHaveBeenLastCalledWith(['Karazhan', 'Black Temple', 'Hyjal Summit', 'Badge vendor', 'Crafted']);
		fireEvent.click(screen.getByTestId('upgrades-view-sources-show-all'));
		expect(onSetAll).toHaveBeenLastCalledWith([]);
	});

	it('counts only the hidden sources the table offers', () => {
		render(<Harness initial={['Karazhan', 'Black Temple']} />);
		expect(summary()).toBe('1 of 4 sources hidden');
	});

	it('says all sources show when only sources the table does not offer are hidden', () => {
		render(<Harness initial={['Karazhan']} />);
		expect(summary()).toBe('Showing all sources');
		open();
		expect(ticked()).toEqual(['true', 'true', 'true', 'true']);
	});
});
