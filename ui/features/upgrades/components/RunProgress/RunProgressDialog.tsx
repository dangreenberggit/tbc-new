import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import { ProgressTrackerDialog, type ProgressTrackerHandle } from '@ui-kit/ProgressTrackerDialog';
import { useEffect, useRef, useState } from 'react';

import { progressOf, subscribeProgress } from '../../model/progress_channel';
import { progressBarOf, progressStageOf } from '../../utils/format';
import { RunProgressMessage } from './RunProgressMessage';

/** One element, so the dialog's own state changes only when the stage does, as upstream's `BulkProgressDialog` keeps it. */
const MESSAGE = <RunProgressMessage />;

export interface RunProgressDialogProps {
	onStop: () => void;
	/** Stop was pressed; the dialog stays up until the step in flight finishes, so it says so. */
	stopping: boolean;
}

/**
 * Mounted only while a run is in flight, as the Bulk dialog is. Progress updates go
 * to the bar through its ref handle, so only a change of stage renders the dialog.
 */
export const RunProgressDialog = ({ onStop, stopping }: RunProgressDialogProps) => {
	const player = usePlayer();
	const [stage, setStage] = useState(() => progressStageOf(progressOf(player)));
	const barRef = useRef<ProgressTrackerHandle>(null);

	useEffect(() => {
		// Updates sent between this render and the effect are not lost: both start from the latest one.
		const latest = progressOf(player);
		if (latest) {
			setStage(progressStageOf(latest));
			barRef.current?.setProgress(progressBarOf(latest));
		}
		return subscribeProgress(player, progress => {
			setStage(progressStageOf(progress));
			barRef.current?.setProgress(progressBarOf(progress));
		});
	}, [player]);

	return (
		<ProgressTrackerDialog
			open
			testId="upgrades-run-progress"
			title={i18n.t('upgrades_tab.run_progress.title', { ns: 'upgrades' })}
			state={{ stage, message: stopping ? i18n.t('upgrades_tab.status.stopping', { ns: 'upgrades' }) : MESSAGE }}
			hasProgressBar
			onCancel={onStop}
			ref={barRef}
		/>
	);
};
