import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { NumberPicker } from '@ui-kit/NumberPicker';
import { useState } from 'react';

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
	const [iterations, setIterations] = useState(initialIterations);

	return (
		<div className="grid gap-6 border border-border bg-background p-4" data-testid="upgrades-run-controls">
			<NumberPicker
				modObject={iterations}
				testId="upgrades-iterations-picker"
				config={{
					id: 'upgrades-iterations',
					label: i18n.t('upgrades_tab.iterations_label'),
					positive: true,
					getValue: value => value,
					setValue: (_value, next) => setIterations(next),
				}}
			/>
			<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={() => onStart(runSettings(iterations, candidateCap))}>
				{i18n.t('upgrades_tab.run')}
			</Button>
		</div>
	);
};
