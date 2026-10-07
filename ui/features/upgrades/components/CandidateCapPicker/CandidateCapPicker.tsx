import i18n from '@i18n/config';
import { NumberPicker } from '@ui-kit/NumberPicker';

import { numberSettingSource } from '../../hooks/useUpgradesStore';
import type { UpgradesStore } from '../../model/upgrades_store';

const CANDIDATE_CAP = numberSettingSource('candidateCap');

export interface CandidateCapPickerProps {
	/** The tab's store, which the picker reads the cap back from. */
	store: UpgradesStore;
	onCapChange: (cap: number) => void;
}

/** The candidate cap: keep the first N candidates of the EP order; empty or 0 is no cap. */
export const CandidateCapPicker = ({ store, onCapChange }: CandidateCapPickerProps) => (
	<NumberPicker
		modObject={store}
		testId="upgrades-candidates-picker"
		config={{
			id: 'upgrades-candidates',
			label: i18n.t('upgrades_tab.candidates_label'),
			positive: true,
			showZeroes: false,
			...CANDIDATE_CAP,
			setValue: (_store, next) => onCapChange(next),
		}}
	/>
);
