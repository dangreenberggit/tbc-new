import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { NumberPicker } from '@ui-kit/NumberPicker';

import { numberSettingSource } from '../../hooks/useUpgradesStore';
import type { UpgradesStore } from '../../model/upgrades_store';

const ITERATIONS = numberSettingSource('iterations');

export interface RunControlsProps {
	ready: boolean;
	running: boolean;
	/** The tab's store, which the picker reads the iterations back from. */
	store: UpgradesStore;
	onIterationsChange: (iterations: number) => void;
	onStart: () => void;
}

/** The iterations field and Run. Stop is the progress dialog's cancel, as on the Bulk tab. */
export const RunControls = ({ ready, running, store, onIterationsChange, onStart }: RunControlsProps) => (
	<div className="grid gap-6" data-testid="upgrades-run-controls">
		<NumberPicker
			modObject={store}
			testId="upgrades-iterations-picker"
			config={{
				id: 'upgrades-iterations',
				label: i18n.t('upgrades_tab.iterations_label'),
				positive: true,
				...ITERATIONS,
				setValue: (_store, next) => onIterationsChange(next),
			}}
		/>
		<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={onStart}>
			{i18n.t('upgrades_tab.run')}
		</Button>
	</div>
);
