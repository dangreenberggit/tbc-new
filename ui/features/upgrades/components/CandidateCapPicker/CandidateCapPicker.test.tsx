import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { createUpgradesStore, dispatchRun, dispatchSettings } from '../../model/upgrades_store';
import { fixtureRow } from '../../testing/ranking_fixture';
import { CandidateCapPicker } from './CandidateCapPicker';

loadEnglishBundles();

const input = () => within(screen.getByTestId('upgrades-candidates-picker')).getByRole('textbox') as HTMLInputElement;

/** The settings hook's contract in small: the change writes the tab store, which the picker reads back. */
const mount = (candidateCap?: number) => {
	const store = createUpgradesStore({ iterations: 500, candidateCap });
	render(<CandidateCapPicker store={store} onCapChange={cap => dispatchSettings(store, { type: 'setCandidateCap', cap })} />);
	return store;
};

describe('CandidateCapPicker', () => {
	it('shows no cap as an empty field, and writes a typed cap to the store', () => {
		const store = mount();
		expect(input().value).toBe('');

		act(() => {
			fireEvent.change(input(), { target: { value: '40' } });
		});
		expect(store.getState().settings.candidateCap).toBe(40);
		expect(input().value).toBe('40');
	});

	it('shows the cap the store holds', () => {
		mount(10);
		expect(input().value).toBe('10');
	});

	// A ring rewrites the field from the store, which would wipe text the user has typed but not committed.
	it('is not rung by a run writing the store', () => {
		const store = mount(10);
		input().value = '7';
		act(() => {
			dispatchRun(store, { type: 'started', runId: 1, startedAt: 0 });
			dispatchRun(store, { type: 'landed', runId: 1, row: fixtureRow(0) });
		});
		expect(input().value).toBe('7');
	});
});
