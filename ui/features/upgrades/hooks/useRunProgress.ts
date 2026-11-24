import { usePlayer } from '@sim/context/SimHostContext';
import { useEffect, useState } from 'react';

import { progressOf, subscribeProgress } from '../model/progress_channel';
import type { RunProgressView } from '../model/run_progress';

/** The run's latest progress, as upstream's `useBulkProgress` gives the Bulk run's. */
export const useRunProgress = (): RunProgressView | null => {
	const player = usePlayer();
	const [progress, setProgress] = useState<RunProgressView | null>(() => progressOf(player));

	// Updates sent between the first render and this effect are not lost: it starts from the latest one.
	useEffect(() => {
		setProgress(progressOf(player));
		return subscribeProgress(player, setProgress);
	}, [player]);

	return progress;
};
