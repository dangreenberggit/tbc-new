import { useRunProgress } from '../../hooks/useRunProgress';
import { progressLabel, progressStageOf, timeLeftText } from '../../utils/format';

/**
 * The stage and the time left. It subscribes to the run's own ticks, so a tick
 * renders this leaf and never the dialog, as upstream's `BulkProgressMessage` does.
 */
export const RunProgressMessage = () => {
	const progress = useRunProgress();
	const timeLeft = progress ? timeLeftText(progress) : undefined;

	return (
		<>
			<div>{progressLabel(progressStageOf(progress))}</div>
			{timeLeft && <div data-testid="upgrades-run-time-left">{timeLeft}</div>}
		</>
	);
};
