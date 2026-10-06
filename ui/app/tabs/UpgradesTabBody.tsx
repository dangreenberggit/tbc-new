import { RunControls } from '@features/upgrades/components/RunControls';
import { RunProgressDialog } from '@features/upgrades/components/RunProgress';
import { StatusLine } from '@features/upgrades/components/StatusLine';
import { UpgradesResults } from '@features/upgrades/components/UpgradesResults';
import { useFixtureAutoload } from '@features/upgrades/hooks/useFixtureAutoload';
import { useUpgradesRun } from '@features/upgrades/hooks/useUpgradesRun';
import { shownRanking } from '@features/upgrades/model/run_reducer';
import { DEV_FLAGS } from '@features/upgrades/utils/dev_flags';
import { selectRunFn } from '@features/upgrades/utils/select_run_fn';
import { useSimReady } from '@sim/hooks/useSimReady';
import { TabPanelColumns } from '@ui-kit/TabPanelColumns';

// Chosen once: the flags are read once per page load, and a production build always gets the live run.
const RUN_FN = selectRunFn(DEV_FLAGS);

export const UpgradesTabBody = () => {
	const ready = useSimReady();
	const { run, start, stop, dispatchFixture } = useUpgradesRun(RUN_FN);
	useFixtureAutoload({ onLoaded: dispatchFixture, currentRanking: () => shownRanking(run) });

	return (
		<>
			<TabPanelColumns.Left variant="stacked" className="pt-2">
				<StatusLine run={run} />
				<UpgradesResults run={run} />
			</TabPanelColumns.Left>
			<TabPanelColumns.Right>
				<div className="sticky top-sim-header pt-6">
					<RunControls
						ready={ready}
						running={run.status === 'running'}
						initialIterations={DEV_FLAGS.iterations}
						candidateCap={DEV_FLAGS.cap}
						onStart={start}
					/>
				</div>
			</TabPanelColumns.Right>
			{run.status === 'running' && <RunProgressDialog onStop={stop} stopping={run.stopping} />}
		</>
	);
};
