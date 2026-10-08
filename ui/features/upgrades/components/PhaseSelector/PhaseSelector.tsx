import i18n from '@i18n/config';
import { Phase } from '@sim/constants/other';
import { useSim } from '@sim/context/SimHostContext';
import { EnumPicker } from '@ui-kit/EnumPicker';
import { useId } from 'react';

const PHASES = [Phase.Phase1, Phase.Phase2, Phase.Phase3, Phase.Phase4, Phase.Phase5];

/** The page's content phase, the same setting the gear picker's phase filter writes. */
export const PhaseSelector = () => {
	const sim = useSim();
	const id = useId();
	return (
		<EnumPicker
			modObject={sim}
			testId="phase-selector"
			config={{
				id,
				label: i18n.t('upgrades_tab.settings.phase_label', { ns: 'upgrades' }),
				values: PHASES.map(phase => ({ name: i18n.t(`common.phases.${phase}`), value: phase })),
				storeField: 'sim:phase',
				getValue: subject => subject.getPhase(),
				setValue: (subject, phase) => subject.setPhase(phase),
			}}
		/>
	);
};
