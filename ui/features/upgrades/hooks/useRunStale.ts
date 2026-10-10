import { useSim } from '@sim/context/SimHostContext';
import { useStoreSubscribe } from '@sim/hooks/useStoreSubscribe';
import { subscribeSimChange } from '@sim/state/subscriptions';

import { inputsSignature, liveInputsKey } from '../model/run_inputs';
import type { RunSettings } from '../model/run_state';
import { selectSettledSignature, useUpgradesStore } from './useUpgradesStore';

/**
 * Whether the result on screen was measured on other inputs than the page and
 * `settings` hold now (ticket 560). Sim settings the run does not read, such
 * as a fixed seed, never mark it stale, and a run in flight is never stale.
 */
export function useRunStale(settings: RunSettings): boolean {
	const sim = useSim();
	// Always subscribed, so the key is current the moment a result appears; a
	// subscription that started with the result would compare one paint against
	// the key read at mount. The key costs about 1 ms per page edit (K2 step 8).
	const liveKey = useStoreSubscribe(subscribeSimChange(sim), () => liveInputsKey(sim));
	const measured = useUpgradesStore(selectSettledSignature);
	return measured !== undefined && inputsSignature({ liveKey, settings }) !== measured;
}
