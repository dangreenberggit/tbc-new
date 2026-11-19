import { RunProgressDialog } from '@features/upgrades/components/RunProgress';
import { RunSettingsPanel } from '@features/upgrades/components/RunSettingsPanel';
import { StaleNotice, StatusLine } from '@features/upgrades/components/StatusLine';
import { UpgradesResults } from '@features/upgrades/components/UpgradesResults';
import { useFixtureWindowHooks } from '@features/upgrades/hooks/useFixtureWindowHooks';
import { useRunStale } from '@features/upgrades/hooks/useRunStale';
import { useUpgradesRun } from '@features/upgrades/hooks/useUpgradesRun';
import { useUpgradesSettings } from '@features/upgrades/hooks/useUpgradesSettings';
import { selectRun, useUpgradesStore } from '@features/upgrades/hooks/useUpgradesStore';
import { specIdFor } from '@features/upgrades/model/run';
import { inputsSignature, pageInputsSignature } from '@features/upgrades/model/run_inputs';
import { finishedRanking, measuredOnOf } from '@features/upgrades/model/run_state';
import { DEV_FLAGS } from '@features/upgrades/utils/dev_flags';
import { runFnForFlags } from '@features/upgrades/utils/run_fn_for_flags';
import { usePlayer, useSim } from '@sim/context/SimHostContext';
import { useSimReady } from '@sim/hooks/useSimReady';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';
import { useCallback } from 'react';

// Chosen once: the flags are read once per page load, and a production build always gets the live run.
const RUN_FN = runFnForFlags(DEV_FLAGS);

/** The tab's content. `UpgradesTabBody` downloads it the first time the tab is opened. */
export const UpgradesTabBodyInner = () => {
	const sim = useSim();
	const player = usePlayer();
	const ready = useSimReady();
	const run = useUpgradesStore(selectRun);
	const { start, stop, loadFixture } = useUpgradesRun(RUN_FN);
	const settings = useUpgradesSettings();
	const { runSettings } = settings;
	const stale = useRunStale(runSettings);
	// Read when Run is clicked or a fixture loads, so it records the page as it is then. Memoised with `onStart`, so
	// each row a run finishes still hands the memoised `RunSettingsPanel` the same handler.
	const signatureNow = useCallback(() => inputsSignature({ liveKey: pageInputsSignature(sim), settings: runSettings }), [sim, runSettings]);
	const { selectedGearSets } = settings;
	const onStart = useCallback(() => start(runSettings, signatureNow(), selectedGearSets), [start, runSettings, signatureNow, selectedGearSets]);
	const specId = measuredOnOf(run)?.specId ?? specIdFor(player.getSpec());
	useFixtureWindowHooks({ onLoaded: ranking => loadFixture(ranking, signatureNow(), selectedGearSets), currentRanking: () => finishedRanking(run) });

	return (
		// `contents`, so the two columns stay the pane's own flex items.
		<div className="contents" data-testid="upgrades-tab-root" data-runner={measuredOnOf(run)?.runner}>
			<TabPanelColumns.Left variant="stacked" className="pt-2">
				<div data-testid="upgrades-tab-left">
					{stale && <StaleNotice />}
					<StatusLine run={run} />
					<UpgradesResults run={run} bisHeadingsOf={settings.bisHeadingsOf} specId={specId} />
				</div>
			</TabPanelColumns.Left>
			{/* First below `xl`, where the columns stack: the run settings panel sits above the results it governs. */}
			<TabPanelColumns.Right className="max-xl:order-first">
				<div className="sticky top-sim-header pt-6">
					<RunSettingsPanel
						settings={settings}
						ready={ready}
						running={run.status === 'running'}
						showDevControls={DEV_FLAGS.dev ?? false}
						onStart={onStart}
					/>
				</div>
			</TabPanelColumns.Right>
			{run.status === 'running' && <RunProgressDialog onStop={stop} stopping={run.stopping} />}
		</div>
	);
};
