import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createUpgradesStore } from '../../model/upgrades_store';
import { loadEnglishBundles } from '../../testing/locales';
import { fixtureRow } from '../../testing/ranking_fixture';
import { RunControls } from './RunControls';

loadEnglishBundles();

/** The settings hook's contract in small: the change writes the tab store, which the picker reads back. */
type MountOptions = { ready?: boolean; running?: boolean; isNative?: boolean; candidates?: number | undefined };

const mount = (options: MountOptions = {}) => {
	const { ready = true, running = false, isNative = false } = options;
	// An explicit `candidates: undefined` is the unknown count, so it does not take the default.
	const candidates = 'candidates' in options ? options.candidates : 399;
	const store = createUpgradesStore({ iterations: 500 });
	const onStart = vi.fn();
	const view = within(
		render(
			<SimHostProvider host={fakeHost({ sim: { isNative } })}>
				<RunControls
					ready={ready}
					running={running}
					store={store}
					candidates={candidates}
					onIterationsChange={iterations => store.getState().setIterations(iterations, undefined)}
					onStart={onStart}
				/>
			</SimHostProvider>,
		).container,
	);
	const runButton = view.getByTestId('upgrades-run-button') as HTMLButtonElement;
	const field = within(view.getByTestId('upgrades-iterations-picker')).getByRole('textbox') as HTMLInputElement;
	return { store, onStart, runButton, field, warning: () => view.queryByTestId('upgrades-iterations-warning') };
};

// The Bulk tab's own text for its iterations warning (assets/locales/en/translation.json, bulk_tab.warning).
const WEB_WARNING =
	'Simming over 1,000,000 iterations in the sim will take a long time or may not run at all. For larger batch sims we recommend downloading the executable and running on your machine.';
const NATIVE_WARNING =
	'Simming over 10,000,000 iterations in the sim will take a long time or may not run at all. For larger batch sims we recommend downloading the executable and running on your machine.';

describe('RunControls', () => {
	it('shows the store’s iterations and runs on a click', () => {
		const { onStart, runButton, field } = mount();
		expect(field.value).toBe('500');

		fireEvent.click(runButton);
		expect(onStart).toHaveBeenCalledOnce();
	});

	it('writes a committed value to the store and keeps it in the field', () => {
		const { store, field } = mount();
		act(() => {
			fireEvent.change(field, { target: { value: '2000' } });
		});
		expect(store.getState().settings.iterations).toBe(2000);
		expect(field.value).toBe('2000');
	});

	it('shows an iterations write made elsewhere', () => {
		const { store, field } = mount();
		act(() => store.getState().setIterations(900, undefined));
		expect(field.value).toBe('900');
	});

	// A notification rewrites the field from the store, which would wipe text the user has typed but not committed.
	it('is not notified by a run writing the store', () => {
		const { store, field } = mount();
		field.value = '12';
		act(() => {
			store.getState().startRun(1, 0);
			store.getState().landRow(1, fixtureRow(0));
		});
		expect(field.value).toBe('12');
	});

	// Like the Bulk tab, the limit is on the run's iterations in all: here at least the baseline and each of the 399
	// eligible candidates, 400 sims, so 2,500 iterations each is exactly 1,000,000.
	describe('the Bulk tab’s iterations warning', () => {
		it('shows when the run sims over 1,000,000 iterations on the web sim, with the Bulk tab’s words, and still lets the run start', () => {
			const { store, runButton, warning } = mount();
			act(() => store.getState().setIterations(2_501, undefined));
			expect(warning()?.getAttribute('aria-label')).toBe(WEB_WARNING);
			expect(runButton.disabled).toBe(false);
		});

		it('does not show at 1,000,000 iterations in all', () => {
			const { store, warning } = mount();
			act(() => store.getState().setIterations(2_500, undefined));
			expect(warning()).toBeNull();
		});

		it('counts only the candidates the cap lets through', () => {
			const { store, warning } = mount();
			act(() => {
				store.getState().setIterations(5_000, undefined);
				store.getState().setCandidateCap(99, undefined);
			});
			expect(warning()).toBeNull();
			act(() => store.getState().setCandidateCap(299, undefined));
			expect(warning()?.getAttribute('aria-label')).toBe(WEB_WARNING);
		});

		it('does not show while the candidate count is unknown', () => {
			const { store, warning } = mount({ candidates: undefined });
			act(() => store.getState().setIterations(20_000_000, undefined));
			expect(warning()).toBeNull();
		});

		// The Bulk tab warns in the downloaded sim too, above its own limit (bulkIterationsLimit in
		// features/bulk/model/limits.ts) and with the same words. 400 sims at 25,000 iterations is exactly 10,000,000.
		it('shows above 10,000,000 iterations in all in the downloaded sim, with the Bulk tab’s words', () => {
			const { store, warning } = mount({ isNative: true });
			act(() => store.getState().setIterations(25_000, undefined));
			expect(warning()).toBeNull();
			act(() => store.getState().setIterations(25_001, undefined));
			expect(warning()?.getAttribute('aria-label')).toBe(NATIVE_WARNING);
		});
	});

	it('cannot run before the sim is ready, or while a run is in flight', () => {
		expect(mount({ ready: false }).runButton.disabled).toBe(true);
		expect(mount({ running: true }).runButton.disabled).toBe(true);
	});
});
