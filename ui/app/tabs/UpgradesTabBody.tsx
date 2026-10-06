import { RunProgressDialog } from '@features/upgrades/components/RunProgress';
import { RunSettingsPanel } from '@features/upgrades/components/RunSettingsPanel';
import { StaleNotice, StatusLine } from '@features/upgrades/components/StatusLine';
import { UpgradesResults } from '@features/upgrades/components/UpgradesResults';
import { useFixtureAutoload } from '@features/upgrades/hooks/useFixtureAutoload';
import { useRunStale } from '@features/upgrades/hooks/useRunStale';
import { useUpgradesRun } from '@features/upgrades/hooks/useUpgradesRun';
import { useUpgradesSettings } from '@features/upgrades/hooks/useUpgradesSettings';
import { inputsSignature, liveInputsKey } from '@features/upgrades/model/run_inputs';
import { DEFAULT_ITERATIONS, measuredOnOf, shownRanking } from '@features/upgrades/model/run_reducer';
import { DEV_FLAGS } from '@features/upgrades/utils/dev_flags';
import { selectRunFn } from '@features/upgrades/utils/select_run_fn';
import { useSim } from '@sim/context/SimHostContext';
import { useSimReady } from '@sim/hooks/useSimReady';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';

// Chosen once: the flags are read once per page load, and a production build always gets the live run.
const RUN_FN = selectRunFn(DEV_FLAGS);
const SETTINGS_SEED = { iterations: DEV_FLAGS.iterations ?? DEFAULT_ITERATIONS, candidateCap: DEV_FLAGS.cap };

export const UpgradesTabBody = () => {
	const sim = useSim();
	const ready = useSimReady();
	const { run, start, stop, dispatchFixture } = useUpgradesRun(RUN_FN);
	const settings = useUpgradesSettings(SETTINGS_SEED);
	const stale = useRunStale(run, settings.runSettings);
	// Read when Run is clicked or a fixture lands, so it records the page as it is then.
	const signatureNow = () => inputsSignature({ liveKey: liveInputsKey(sim), settings: settings.runSettings });
	useFixtureAutoload({ onLoaded: ranking => dispatchFixture(ranking, signatureNow()), currentRanking: () => shownRanking(run) });

	return (
		// `contents`, so the two columns stay the pane's own flex items.
		<div className="contents" data-testid="upgrades-tab-root" data-runner={measuredOnOf(run)?.runner}>
			<TabPanelColumns.Left variant="stacked" className="pt-2">
				<div data-testid="upgrades-tab-left">
					{stale && <StaleNotice />}
					<StatusLine run={run} />
					<UpgradesResults run={run} selectedSets={settings.selectedOptions} />
				</div>
			</TabPanelColumns.Left>
			{/* First below `xl`, where the columns stack: the run card sits above the results it governs. */}
			<TabPanelColumns.Right className="max-xl:order-first">
				<div className="sticky top-sim-header pt-6">
					<RunSettingsPanel
						settings={settings}
						ready={ready}
						running={run.status === 'running'}
						devVisible={DEV_FLAGS.dev ?? false}
						onStart={() => start(settings.runSettings, signatureNow())}
					/>
				</div>
			</TabPanelColumns.Right>
			{run.status === 'running' && <RunProgressDialog onStop={stop} stopping={run.stopping} />}
		</div>
	);
};
