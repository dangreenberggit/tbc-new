import i18n from '@i18n/config';
import { Button } from '@ui-kit/Button';
import clsx from 'clsx';
import { memo, useId, useState } from 'react';

import type { UpgradesSettings } from '../../hooks/useUpgradesSettings';
import { EligibleCount } from '../EligibleCount';
import { GearSetChips } from '../GearSetChips';
import { PhaseSelector } from '../PhaseSelector';
import { RunControls } from '../RunControls';
import { SourcesButton } from '../SourcesDialog';

export interface RunSettingsPanelProps {
	settings: UpgradesSettings;
	ready: boolean;
	running: boolean;
	onStart: () => void;
}

/**
 * The run settings panel. Below `xl` the settings sit behind a summary button, so a
 * phone does not scroll past them to reach the results; the eligible count and Run
 * never collapse. Memoized: every row a run finishes renders the tab but changes no prop.
 */
export const RunSettingsPanel = memo(({ settings, ready, running, onStart }: RunSettingsPanelProps) => {
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
				<SourcesButton sources={settings.sources} excluded={settings.excludedSources} onToggle={settings.toggleExcludedSource} />
				<GearSetChips
					chips={settings.chips}
					selectedKeys={settings.selectedKeys}
					prune={settings.prune}
					onToggleGearSet={settings.toggleGearSet}
					onPruneChange={settings.setPrune}
				/>
			</div>
			<EligibleCount count={settings.eligibleCount} />
			<RunControls ready={ready} running={running} store={settings.store} onIterationsChange={settings.setIterations} onStart={onStart} />
		</div>
	);
});
