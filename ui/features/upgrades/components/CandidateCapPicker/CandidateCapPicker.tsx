import i18n from '@i18n/config';
import { NumberPicker } from '@ui-kit/NumberPicker';

import { numberSettingSource } from '../../hooks/useUpgradesStore';
import type { UpgradesStore } from '../../model/upgrades_store';

const CANDIDATE_CAP = numberSettingSource('candidateCap');

export interface CandidateCapPickerProps {
	store: UpgradesStore;
	onCapChange: (cap: number) => void;
}

/** The candidate cap: keep the first N candidates of the EP order that the player does not wear; empty or 0 is no cap. */
export const CandidateCapPicker = ({ store, onCapChange }: CandidateCapPickerProps) => (
	<NumberPicker
		modObject={store}
		testId="upgrades-candidate-cap-picker"
		config={{
			id: 'upgrades-candidate-cap',
			label: i18n.t('upgrades_tab.candidates_label', { ns: 'upgrades' }),
			positive: true,
			showZeroes: false,
			...CANDIDATE_CAP,
			setValue: (_store, next) => onCapChange(next),
		}}
	/>
);
