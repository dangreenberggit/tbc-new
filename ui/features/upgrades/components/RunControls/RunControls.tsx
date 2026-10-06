import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { NumberPicker } from '@ui-kit/NumberPicker';

import type { NumberField } from '../../hooks/useUpgradesSettings';

export interface RunControlsProps {
	ready: boolean;
	running: boolean;
	/** The settings hook's holder, which the picker reads the typed value back from. */
	iterationsField: NumberField;
	onIterationsChange: (iterations: number) => void;
	onStart: () => void;
}

/** The iterations field and Run. Stop is the progress dialog's cancel, as on the Bulk tab. */
export const RunControls = ({ ready, running, iterationsField, onIterationsChange, onStart }: RunControlsProps) => (
	<div className="grid gap-6" data-testid="upgrades-run-controls">
		<NumberPicker
			modObject={iterationsField}
			testId="upgrades-iterations-picker"
			config={{
				id: 'upgrades-iterations',
				label: i18n.t('upgrades_tab.iterations_label'),
				positive: true,
				getValue: field => field.current,
				setValue: (_field, next) => onIterationsChange(next),
			}}
		/>
		<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={onStart}>
			{i18n.t('upgrades_tab.run')}
		</Button>
	</div>
);
