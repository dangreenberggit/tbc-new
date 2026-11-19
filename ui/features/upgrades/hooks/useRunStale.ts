import { useSim } from '@sim/context/SimHostContext';
import { useStoreSubscribe } from '@sim/hooks/useStoreSubscribe';
import { subscribeSimChange } from '@sim/state/subscriptions';

import { inputsSignature, pageInputsSignature } from '../model/run_inputs';
import type { RunSettings } from '../model/run_state';
import { selectSettledSignature, useUpgradesStore } from './useUpgradesStore';

/**
 * Whether the result on screen was measured on other inputs than the page and
 * `settings` hold now. Sim settings the run does not read, such as a fixed seed,
 * never mark it stale, and a run in flight is never stale.
 */
export function useRunStale(settings: RunSettings): boolean {
	const sim = useSim();
	// Always subscribed, so the key is current the moment a result appears; one that
	// started with the result would compare one paint against the key read at mount.
	const liveKey = useStoreSubscribe(subscribeSimChange(sim), () => pageInputsSignature(sim));
	const settledSignature = useUpgradesStore(selectSettledSignature);
	return settledSignature !== undefined && inputsSignature({ liveKey, settings }) !== settledSignature;
}
