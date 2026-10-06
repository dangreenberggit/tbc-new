import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import { useId, useState } from 'react';

import type { UpgradesSettings } from '../../hooks/useUpgradesSettings';
import { CandidateCapPicker } from '../CandidateCapPicker';
import { EligibleCount } from '../EligibleCount';
import { PhaseSelector } from '../PhaseSelector';
import { RunControls } from '../RunControls';
import { SetChips } from '../SetChips';
import { SourcesButton } from '../SourcesDialog';

export interface RunSettingsPanelProps {
	settings: UpgradesSettings;
	ready: boolean;
	running: boolean;
	/** `?upgrades-dev`: shows the candidate cap. */
	devVisible: boolean;
	onStart: () => void;
}

/**
 * The run card. Below `xl` the settings sit behind a summary button, so a
 * phone does not scroll past them to reach the results; the eligible count
 * and Run stay outside it and never collapse (ticket 321).
 */
export const RunSettingsPanel = ({ settings, ready, running, devVisible, onStart }: RunSettingsPanelProps) => {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	const { state, dispatch } = settings;
	return (
		<div className="grid gap-6 border border-border bg-background p-4" data-testid="upgrades-run-settings">
			<Button
				variant="secondary"
				className="xl:hidden"
				data-testid="upgrades-run-settings-summary"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(!open)}>
				{i18n.t('upgrades_tab.settings_title')}
			</Button>
			<div id={bodyId} className={clsx(open ? 'grid' : 'hidden', 'gap-6 xl:grid')} data-testid="upgrades-run-settings-body">
				<PhaseSelector />
				<SourcesButton sources={settings.sources} excluded={state.excludedSources} onToggle={key => dispatch({ type: 'toggleSource', key })} />
				<SetChips
					chips={settings.chips}
					selectedKeys={settings.selectedKeys}
					otherOpen={state.otherSetsOpen}
					prune={state.prune}
					onToggleSet={key => dispatch({ type: 'toggleSet', key })}
					onToggleOther={() => dispatch({ type: 'toggleOtherSets' })}
					onPruneChange={prune => dispatch({ type: 'setPrune', prune })}
				/>
				<CandidateCapPicker capField={settings.capField} onCapChange={settings.onCapChange} hidden={!devVisible} />
			</div>
			<EligibleCount count={settings.eligibleCount} />
			<RunControls
				ready={ready}
				running={running}
				iterationsField={settings.iterationsField}
				onIterationsChange={settings.onIterationsChange}
				onStart={onStart}
			/>
		</div>
	);
};
