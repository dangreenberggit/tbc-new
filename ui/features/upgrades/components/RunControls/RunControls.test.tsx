import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ITERATIONS } from '../../model/run_reducer';
import { RunControls, type RunControlsProps } from './RunControls';

const mount = (props: Partial<RunControlsProps> = {}) => {
	const onStart = vi.fn();
	const view = within(render(<RunControls ready running={false} onStart={onStart} {...props} />).container);
	const runButton = view.getByTestId('upgrades-run-button') as HTMLButtonElement;
	const field = within(view.getByTestId('upgrades-iterations-picker')).getByRole('textbox') as HTMLInputElement;
	return { onStart, runButton, field };
};

describe('RunControls', () => {
	it('runs with the default iterations and no cap', () => {
		const { onStart, runButton, field } = mount();
		expect(field.value).toBe(String(DEFAULT_ITERATIONS));

		fireEvent.click(runButton);
		expect(onStart).toHaveBeenCalledWith({ iterations: DEFAULT_ITERATIONS, candidateCap: undefined });
	});

	it('seeds the field from the dev flags and passes their cap', () => {
		const { onStart, runButton, field } = mount({ initialIterations: 500, candidateCap: 10 });
		expect(field.value).toBe('500');

		fireEvent.click(runButton);
		expect(onStart).toHaveBeenCalledWith({ iterations: 500, candidateCap: 10 });
	});

	it('runs with the iterations the user committed', () => {
		const { onStart, runButton, field } = mount();
		fireEvent.change(field, { target: { value: '750' } });

		fireEvent.click(runButton);
		expect(onStart).toHaveBeenCalledWith({ iterations: 750, candidateCap: undefined });
	});

	it('cannot run before the sim is ready, or while a run is in flight', () => {
		expect(mount({ ready: false }).runButton.disabled).toBe(true);
		expect(mount({ running: true }).runButton.disabled).toBe(true);
	});
});
