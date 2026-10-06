import i18n from '@i18n/config';
import { NumberPicker } from '@ui-kit/NumberPicker';

import type { NumberField } from '../../hooks/useUpgradesSettings';

export interface CandidateCapPickerProps {
	/** The settings hook's holder, which the picker reads the typed value back from. */
	capField: NumberField;
	onCapChange: (cap: number) => void;
	hidden: boolean;
}

/**
 * The candidate cap; empty or 0 is no cap. Always in the page and hidden
 * unless `?upgrades-dev`, because the desktop gate writes this input on a
 * production build, and a cut of the candidate list the user cannot see
 * drops real upgrades (ticket 466).
 */
export const CandidateCapPicker = ({ capField, onCapChange, hidden }: CandidateCapPickerProps) => (
	<div hidden={hidden}>
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
	</div>
);
