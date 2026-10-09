import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { SourcesButton } from './SourcesButton';

loadEnglishBundles();

const SOURCES = {
	raids: [
		{ key: 'Black Temple', count: 3 },
		{ key: 'Hyjal Summit', count: 2 },
	],
	other: [{ key: 'Badge vendor', count: 1 }],
};

/** The settings reducer's toggle in small, so the dialog shows what a click changed. */
const Harness = ({ sources = SOURCES }: { sources?: typeof SOURCES }) => {
	const [excluded, setExcluded] = useState<readonly string[]>([]);
	const onToggle = (key: string) => setExcluded(keys => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]));
	return <SourcesButton sources={sources} excluded={excluded} onToggle={onToggle} />;
};

const summary = () => screen.getByTestId('upgrades-sources-summary').textContent;
const row = (key: string) => {
	const found = screen.getAllByTestId('upgrades-source-row').find(element => element.dataset.source === key);
	if (!found) throw new Error(`no source row ${key}`);
	return found;
};

describe('SourcesButton', () => {
	it('lists raids and other sources in two groups, every source ticked', () => {
		render(<Harness />);
		expect(summary()).toBe('All 3 sources included');
		fireEvent.click(screen.getByTestId('upgrades-sources-button'));

		const dialog = screen.getByTestId('upgrades-sources-dialog');
		expect([...dialog.querySelectorAll('legend')].map(legend => legend.textContent)).toEqual(['Raids', 'Other sources']);
		expect(screen.getAllByTestId('upgrades-source-row').map(element => element.dataset.source)).toEqual(['Black Temple', 'Hyjal Summit', 'Badge vendor']);
		expect(
			within(dialog)
				.getAllByRole('checkbox')
				.map(box => box.getAttribute('aria-checked')),
		).toEqual(['true', 'true', 'true']);
	});

	it('unticks a source and counts it in the summary', () => {
		render(<Harness />);
		fireEvent.click(screen.getByTestId('upgrades-sources-button'));
		fireEvent.click(within(row('Hyjal Summit')).getByRole('checkbox'));

		expect(within(row('Hyjal Summit')).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
		expect(summary()).toBe('1 of 3 sources excluded');
	});

	it('cannot open with no sources to offer', () => {
		render(<Harness sources={{ raids: [], other: [] }} />);
		expect((screen.getByTestId('upgrades-sources-button') as HTMLButtonElement).disabled).toBe(true);
	});
});
