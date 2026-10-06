import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import { ProgressTrackerDialog, type ProgressTrackerHandle } from '@ui-kit/ProgressTrackerDialog';
import { useEffect, useRef, useState } from 'react';

import { progressOf, subscribeProgress } from '../../model/progress_channel';
import { progressBarOf, progressLabel, progressStageOf } from '../../utils/format';

export interface RunProgressDialogProps {
	onStop: () => void;
}

/**
 * Mounted only while a run is in flight, as the Bulk dialog is. A tick goes to
 * the bar through its handle, so only a change of stage renders the dialog.
 */
export const RunProgressDialog = ({ onStop }: RunProgressDialogProps) => {
	const player = usePlayer();
	const [stage, setStage] = useState(() => progressStageOf(progressOf(player)));
	const barRef = useRef<ProgressTrackerHandle>(null);

	useEffect(() => {
		// Ticks sent between Run and this effect are not lost: the bar starts from the latest one.
		const latest = progressOf(player);
		if (latest) barRef.current?.setProgress(progressBarOf(latest));
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
			state={{ stage, message: progressLabel(stage) }}
			hasProgressBar
			onCancel={onStop}
			ref={barRef}
		/>
	);
};
