import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { NumberPicker } from '@ui-kit/NumberPicker';
import { useRef } from 'react';

import { DEFAULT_ITERATIONS, type RunSettings, runSettings } from '../../model/run_reducer';

export interface RunControlsProps {
	ready: boolean;
	running: boolean;
	/** Seeds the iterations field; a dev flag sets it for a short live check. */
	initialIterations?: number;
	/** Keeps the first N candidates; only a dev flag sets it before P3's control exists. */
	candidateCap?: number;
	onStart: (settings: RunSettings) => void;
}

/** The run card: the iterations field and Run. Stop is the progress dialog's cancel, as on the Bulk tab. */
export const RunControls = ({ ready, running, initialIterations = DEFAULT_ITERATIONS, candidateCap, onStart }: RunControlsProps) => {
	// A ref, as upstream's Bulk search keeps its ilvl fields: the picker re-reads `getValue` on its own
	// notification, so it must read a live value, not this render's (`ui-kit/input.ts`, `getValue`).
	const iterations = useRef(initialIterations);

	return (
		<div className="grid gap-6 border border-border bg-background p-4" data-testid="upgrades-run-controls">
			<NumberPicker
				modObject={iterations}
				testId="upgrades-iterations-picker"
				config={{
					id: 'upgrades-iterations',
					label: i18n.t('upgrades_tab.iterations_label'),
					positive: true,
					getValue: field => field.current,
					setValue: (field, next) => {
						field.current = next;
					},
				}}
			/>
			<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={() => onStart(runSettings(iterations.current, candidateCap))}>
				{i18n.t('upgrades_tab.run')}
			</Button>
		</div>
	);
};
