import { useSim } from '@sim/context/SimHostContext';
import { useStoreSubscribe } from '@sim/hooks/useStoreSubscribe';
import { type StoreSubscribe, subscribeSimChange } from '@sim/state/subscriptions';

import { inputsSignature, liveInputsKey } from '../model/run_inputs';
import type { RunSettings, RunState } from '../model/run_reducer';

const NO_CHANGES: StoreSubscribe = () => () => {};

/**
 * Whether the result on screen was measured on other inputs than the page and
 * `settings` hold now (ticket 560). Sim settings the run does not read, such
 * as a fixed seed, never mark it stale.
 */
export function useRunStale(run: RunState, settings: RunSettings): boolean {
	const sim = useSim();
	const measured = run.status === 'done' || run.status === 'stopped' ? run.measuredOn?.inputsSignature : undefined;
	// Subscribed only while a result is shown: the tab stays mounted behind the
	// other tabs, and the key serialises the whole raid on every page edit.
	const liveKey = useStoreSubscribe(measured === undefined ? NO_CHANGES : subscribeSimChange(sim), () => liveInputsKey(sim));
	return measured !== undefined && inputsSignature({ liveKey, settings }) !== measured;
}
