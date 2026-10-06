import i18n from '@i18n/config';
import { NumberPicker } from '@ui-kit/NumberPicker';

import type { NumberField } from '../../hooks/useUpgradesSettings';

export interface CandidateCapPickerProps {
	/** The settings hook's holder, which the picker reads the typed value back from. */
	capField: NumberField;
	onCapChange: (cap: number) => void;
}

/** The candidate cap: keep the first N candidates of the EP order; empty or 0 is no cap. */
export const CandidateCapPicker = ({ capField, onCapChange }: CandidateCapPickerProps) => (
	<NumberPicker
		modObject={capField}
		testId="upgrades-candidates-picker"
		config={{
			id: 'upgrades-candidates',
			label: i18n.t('upgrades_tab.candidates_label'),
			positive: true,
			showZeroes: false,
			getValue: field => field.current,
			setValue: (_field, next) => onCapChange(next),
		}}
	/>
);
