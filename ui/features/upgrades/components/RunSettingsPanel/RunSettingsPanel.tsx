import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import { memo, useId, useState } from 'react';

import type { UpgradesSettings } from '../../hooks/useUpgradesSettings';
import { CandidateCapPicker } from '../CandidateCapPicker';
import { FixtureFileInput } from '../DevTools';
import { EligibleCount } from '../EligibleCount';
import { PhaseSelector } from '../PhaseSelector';
import { RunControls } from '../RunControls';
import { SetChips } from '../SetChips';
import { SourcesButton } from '../SourcesDialog';

export interface RunSettingsPanelProps {
	settings: UpgradesSettings;
	ready: boolean;
	running: boolean;
	/** `?upgrades-dev`: shows the candidate cap and the fixture file input. */
	devVisible: boolean;
	onStart: () => void;
}

/**
 * The run card. Below `xl` the settings sit behind a summary button, so a
 * phone does not scroll past them to reach the results; the eligible count
 * and Run stay outside it and never collapse (ticket 321). Memoised: the tab
 * renders again for every row a run lands, which changes none of its props.
 */
export const RunSettingsPanel = memo(({ settings, ready, running, devVisible, onStart }: RunSettingsPanelProps) => {
	const [open, setOpen] = useState(false);
	const bodyId = useId();
	return (
		<div className="grid gap-6 border border-border bg-background p-4" data-testid="upgrades-run-settings">
			<Button
				variant="secondary"
				className="xl:hidden"
				data-testid="upgrades-run-settings-summary"
				aria-expanded={open}
				aria-controls={bodyId}
				onClick={() => setOpen(wasOpen => !wasOpen)}>
				{i18n.t('upgrades_tab.settings_title', { ns: 'upgrades' })}
			</Button>
			<div id={bodyId} className={clsx(open ? 'grid' : 'hidden', 'gap-6 xl:grid')} data-testid="upgrades-run-settings-body">
				<PhaseSelector />
				<SourcesButton sources={settings.sources} excluded={settings.excludedSources} onToggle={settings.toggleSource} />
				<SetChips
					chips={settings.chips}
					selectedKeys={settings.selectedKeys}
					prune={settings.prune}
					onToggleSet={settings.toggleSet}
					onPruneChange={settings.setPrune}
				/>
				{/* Always in the page: the desktop gate writes the cap input on a production build. Hidden without
				    `?upgrades-dev`, because a cut of the candidate list the user cannot see drops real upgrades (ticket 466). */}
				<div className="grid gap-6" hidden={!devVisible}>
					<CandidateCapPicker store={settings.store} onCapChange={settings.setCandidateCap} />
					<FixtureFileInput />
				</div>
			</div>
			<EligibleCount count={settings.eligibleCount} />
			<RunControls ready={ready} running={running} store={settings.store} onIterationsChange={settings.setIterations} onStart={onStart} />
		</div>
	);
});
