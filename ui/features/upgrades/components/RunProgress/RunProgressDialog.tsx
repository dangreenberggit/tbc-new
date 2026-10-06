import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import { ProgressTrackerDialog, type ProgressTrackerHandle } from '@ui-kit/ProgressTrackerDialog';
import { useEffect, useRef, useState } from 'react';

import { progressOf, subscribeProgress } from '../../model/progress_channel';
import { progressBarOf, progressLabel, progressStageOf } from '../../utils/format';

export interface RunProgressDialogProps {
	onStop: () => void;
	/** Stop was pressed; the dialog stays up until the step in flight finishes, so it says so. */
	stopping: boolean;
}

/**
 * Mounted only while a run is in flight, as the Bulk dialog is. A tick goes to
 * the bar through its handle, so only a change of stage renders the dialog.
 */
export const RunProgressDialog = ({ onStop, stopping }: RunProgressDialogProps) => {
	const player = usePlayer();
	const [stage, setStage] = useState(() => progressStageOf(progressOf(player)));
	const barRef = useRef<ProgressTrackerHandle>(null);

	useEffect(() => {
		// Ticks sent between this render and the effect are not lost: both start from the latest one.
		const latest = progressOf(player);
		if (latest) {
			setStage(progressStageOf(latest));
			barRef.current?.setProgress(progressBarOf(latest));
		}
		return subscribeProgress(player, view => {
			setStage(progressStageOf(view));
			barRef.current?.setProgress(progressBarOf(view));
		});
	}, [player]);

	return (
		<ProgressTrackerDialog
			open
			testId="upgrades-run-progress"
			title={i18n.t('upgrades_tab.run_progress.title')}
			state={{ stage, message: stopping ? i18n.t('upgrades_tab.status.stopping') : progressLabel(stage) }}
			hasProgressBar
			onCancel={onStop}
			ref={barRef}
		/>
	);
};
