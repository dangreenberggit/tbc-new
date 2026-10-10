import { act, fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createUpgradesStore } from '../../model/upgrades_store';
import { fixtureRow } from '../../testing/ranking_fixture';
import { RunControls } from './RunControls';

/** The settings hook's contract in small: the change writes the tab store, which the picker reads back. */
const mount = ({ ready = true, running = false }: { ready?: boolean; running?: boolean } = {}) => {
	const store = createUpgradesStore({ iterations: 500 });
	const onStart = vi.fn();
	const view = within(
		render(
			<RunControls
				ready={ready}
				running={running}
				store={store}
				onIterationsChange={iterations => store.getState().setIterations(iterations, undefined)}
				onStart={onStart}
			/>,
		).container,
	);
	const runButton = view.getByTestId('upgrades-run-button') as HTMLButtonElement;
	const field = within(view.getByTestId('upgrades-iterations-picker')).getByRole('textbox') as HTMLInputElement;
	return { store, onStart, runButton, field };
};

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

	// A ring rewrites the field from the store, which would wipe text the user has typed but not committed.
	it('is not rung by a run writing the store', () => {
		const { store, field } = mount();
		field.value = '12';
		act(() => {
			store.getState().startRun(1, 0);
			store.getState().landRow(1, fixtureRow(0));
		});
		expect(field.value).toBe('12');
	});

	it('cannot run before the sim is ready, or while a run is in flight', () => {
		expect(mount({ ready: false }).runButton.disabled).toBe(true);
		expect(mount({ running: true }).runButton.disabled).toBe(true);
	});
});
