import { act, fireEvent, render, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { NumberField } from '../../hooks/useUpgradesSettings';
import { RunControls } from './RunControls';

/** The settings hook's contract in small: the change writes the holder, then re-renders the parent. */
const Harness = ({
	ready = true,
	running = false,
	writeHolder = true,
	onStart,
}: {
	ready?: boolean;
	running?: boolean;
	writeHolder?: boolean;
	onStart: () => void;
}) => {
	const [field] = useState<NumberField>(() => ({ current: 500 }));
	const [, setIterations] = useState(500);
	return (
		<RunControls
			ready={ready}
			running={running}
			iterationsField={field}
			onIterationsChange={iterations => {
				if (writeHolder) field.current = iterations;
				setIterations(iterations);
			}}
			onStart={onStart}
		/>
	);
};

const mount = (props: { ready?: boolean; running?: boolean; writeHolder?: boolean } = {}) => {
	const onStart = vi.fn();
	const view = within(render(<Harness onStart={onStart} {...props} />).container);
	const runButton = view.getByTestId('upgrades-run-button') as HTMLButtonElement;
	const field = within(view.getByTestId('upgrades-iterations-picker')).getByRole('textbox') as HTMLInputElement;
	return { onStart, runButton, field };
};

describe('RunControls', () => {
	it('shows the holder’s iterations and runs on a click', () => {
		const { onStart, runButton, field } = mount();
		expect(field.value).toBe('500');

		fireEvent.click(runButton);
		expect(onStart).toHaveBeenCalledOnce();
	});

	it('keeps a committed value in the field after the parent re-renders', () => {
		const { field } = mount();
		act(() => {
			fireEvent.change(field, { target: { value: '2000' } });
		});
		expect(field.value).toBe('2000');
	});

	// The fault a holder prevents: a picker model that is not written before the re-read shows the old value again.
	it('reverts the field when the change does not write the holder first', () => {
		const { field } = mount({ writeHolder: false });
		act(() => {
			fireEvent.change(field, { target: { value: '2000' } });
		});
		expect(field.value).toBe('500');
	});

	it('cannot run before the sim is ready, or while a run is in flight', () => {
		expect(mount({ ready: false }).runButton.disabled).toBe(true);
		expect(mount({ running: true }).runButton.disabled).toBe(true);
	});
});
