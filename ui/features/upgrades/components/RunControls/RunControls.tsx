import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import { NumberPicker } from '@ui-kit/NumberPicker';

import type { UpgradesStore } from '../../model/upgrades_store';

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
				// The iterations alone, so a row a run lands does not ring the field.
				storeSubscribe: tabStore => listener => tabStore.subscribe(state => state.settings.iterations, listener),
				getValue: tabStore => tabStore.getState().settings.iterations,
				setValue: (_tabStore, next) => onIterationsChange(next),
			}}
		/>
		<Button data-testid="upgrades-run-button" disabled={!ready || running} onClick={onStart}>
			{i18n.t('upgrades_tab.run')}
		</Button>
	</div>
);
