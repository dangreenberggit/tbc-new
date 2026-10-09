import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SetOption } from '../../model/settings_pool';
import { SetChips, type SetChipsProps } from './SetChips';

loadEnglishBundles();

const option = (key: string, label: string, inPool: number): SetOption => ({ key, name: label, label, kind: 'preset', itemIds: [1, 2, 3], inPool });
const P3 = option('preset:3:P3', 'P3', 3);
const EMPTY = option('preset:3:Empty', 'Empty', 0);
const P2 = option('preset:2:P2', 'P2', 2);

const mount = (props: Partial<SetChipsProps> = {}) => {
	const handlers = { onToggleSet: vi.fn(), onPruneChange: vi.fn() };
	render(<SetChips chips={{ main: [P3, EMPTY], other: [P2] }} selectedKeys={[]} prune={false} {...handlers} {...props} />);
	return handlers;
};

const chip = (key: string) => {
	const found = screen.getAllByTestId('upgrades-set-chip').find(element => element.dataset.setKey === key);
	if (!found) throw new Error(`no chip ${key}`);
	return within(found).getByRole('button');
};

const disclosed = (disclosure: HTMLElement) => document.getElementById(disclosure.getAttribute('aria-controls') ?? '');

describe('SetChips', () => {
	it('toggles a set from its chip and says which chips are selected', () => {
		const { onToggleSet } = mount({ selectedKeys: ['preset:3:P3'] });
		expect(chip('preset:3:P3').getAttribute('aria-pressed')).toBe('true');
		expect(chip('preset:3:P3').dataset.tooltipContent).toBe('3/3 in pool');

		fireEvent.click(chip('preset:3:P3'));
		expect(onToggleSet).toHaveBeenCalledWith('preset:3:P3');
	});

	it('shows a set with nothing in the pool, but does not let it be picked', () => {
		const { onToggleSet } = mount();
		expect(chip('preset:3:Empty').getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(chip('preset:3:Empty'));
		expect(onToggleSet).not.toHaveBeenCalled();
	});

	it('keeps other-phase sets behind a closed disclosure that says how many it holds, and opens it on a click', () => {
		mount();
		const disclosure = screen.getByTestId('upgrades-sets-other');
		expect(disclosure.textContent).toBe('Other sets (1)');
		expect(disclosure.getAttribute('aria-expanded')).toBe('false');
		expect(disclosed(disclosure)?.hidden).toBe(true);

		fireEvent.click(disclosure);
		expect(disclosure.getAttribute('aria-expanded')).toBe('true');
		expect(disclosed(disclosure)?.hidden).toBe(false);
		expect(chip('preset:2:P2')).not.toBeNull();
	});

	it('has no disclosure when every set is shown', () => {
		mount({ chips: { main: [P3], other: [] } });
		expect(screen.queryByTestId('upgrades-sets-other')).toBeNull();
	});

	it('offers the prune only while a set is selected', () => {
		mount();
		expect(screen.queryByTestId('upgrades-prune')).toBeNull();
	});

	it('ticks the prune', () => {
		const { onPruneChange } = mount({ selectedKeys: ['preset:3:P3'] });
		const prune = screen.getByTestId('upgrades-prune');
		expect(prune.textContent).toContain('Sim only selected set items');
		fireEvent.click(within(prune).getByRole('checkbox'));
		expect(onPruneChange).toHaveBeenCalledWith(true);
	});
});
