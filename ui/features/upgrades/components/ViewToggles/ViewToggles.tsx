import i18n from '@i18n/config';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { useId } from 'react';

import type { ViewToggles as Toggles } from '../../model/results_view';
import { ViewSourcesButton, type ViewSourcesButtonProps } from '../ViewSources';

interface ViewToggleProps {
	testId: string;
	label: string;
	tooltip: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}

/** One view toggle: a checkbox whose label carries the tooltip that says what it does. */
const ViewToggle = ({ testId, label, tooltip, checked, onChange }: ViewToggleProps) => {
	const id = useId();
	return (
		<div data-testid={testId}>
			<BooleanPicker modObject={null} config={{ id, label, labelTooltip: tooltip, layout: 'inline', value: checked, onChange }} />
		</div>
	);
};

export interface ViewTogglesProps {
	/** The toggles the run offers; nothing renders when it offers none. */
	offered: Toggles;
	toggles: Toggles;
	/** The phase whose BiS list BiS only keeps. */
	maxPhase: number;
	onChange: (toggle: keyof Toggles, on: boolean) => void;
	/** "Filter by source", shown when the settled table has a source to filter. */
	sources: ViewSourcesButtonProps;
}

/**
 * The view toggles over a finished ranking, titled for what they do to rows
 * already measured, so they cannot be read as more run settings (old tab).
 * "Filter by source" also shows over a stopped run's table, which is settled
 * too; the toggles do not.
 */
export const ViewToggles = ({ offered, toggles, maxPhase, onChange, sources }: ViewTogglesProps) => {
	const offersSources = sources.options.raids.length + sources.options.other.length > 0;
	if (!offered.withSetPotential && !offered.onlyBis && !offersSources) return null;
	return (
		<fieldset className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1" data-testid="upgrades-view-toggles">
			<legend className="float-left mr-6 mb-0 text-sm font-bold">{i18n.t('upgrades_tab.view.title', { ns: 'upgrades' })}</legend>
			{offered.withSetPotential && (
				<ViewToggle
					testId="upgrades-view-set-potential"
					label={i18n.t('upgrades_tab.view.set_potential', { ns: 'upgrades' })}
					tooltip={i18n.t('upgrades_tab.view.set_potential_tooltip', { ns: 'upgrades' })}
					checked={toggles.withSetPotential}
					onChange={on => onChange('withSetPotential', on)}
				/>
			)}
			{offered.onlyBis && (
				<ViewToggle
					testId="upgrades-view-only-bis"
					label={i18n.t('upgrades_tab.view.only_bis', { ns: 'upgrades' })}
					tooltip={i18n.t('upgrades_tab.view.only_bis_tooltip', { ns: 'upgrades', phase: i18n.t(`common.phases.${maxPhase}`) })}
					checked={toggles.onlyBis}
					onChange={on => onChange('onlyBis', on)}
				/>
			)}
			{offersSources && <ViewSourcesButton {...sources} />}
		</fieldset>
	);
};
