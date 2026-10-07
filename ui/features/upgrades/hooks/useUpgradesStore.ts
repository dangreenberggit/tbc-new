import { useSim } from '@sim/context/SimHostContext';
import type { Sim } from '@sim/sim';
import type { StoreSubscribe } from '@sim/state/subscriptions';
import { useStore } from 'zustand';

import { DEFAULT_ITERATIONS } from '../model/run_reducer';
import { createUpgradesStore, type SettingsSeed, type UpgradesState, type UpgradesStore } from '../model/upgrades_store';
import { DEV_FLAGS } from '../utils/dev_flags';

export { selectMeasuredOn, selectRun, selectRunStatus, selectSettledSignature, selectShownRanking } from '../model/upgrades_store';

/** The dev link's iterations and cap, read once per page load. One constant, so the store starts the same whichever reader creates it. */
const SETTINGS_SEED: SettingsSeed = { iterations: DEV_FLAGS.iterations ?? DEFAULT_ITERATIONS, candidateCap: DEV_FLAGS.cap };

const stores = new WeakMap<Sim, UpgradesStore>();

/**
 * The Upgrades tab's store for a page's `Sim`, as upstream keeps one sim store
 * per `Sim` (ticket 564). Any reader on the page finds it from the `Sim` it
 * already has, with no provider; the first reader creates it.
 */
export function upgradesStoreFor(sim: Sim): UpgradesStore {
	let store = stores.get(sim);
	if (!store) {
		store = createUpgradesStore(SETTINGS_SEED);
		stores.set(sim, store);
	}
	return store;
}

export const useUpgradesStoreApi = (): UpgradesStore => upgradesStoreFor(useSim());

/**
 * A number picker's change source and read for one tab setting, with the tab
 * store as its model. It rings on that field alone, so a row a run lands does
 * not rewrite the field. Writes go through `useUpgradesSettings`, which
 * applies the scope's default sets first.
 */
export const numberSettingSource = (field: 'iterations' | 'candidateCap') => ({
	storeSubscribe:
		(store: UpgradesStore): StoreSubscribe =>
		listener =>
			store.subscribe(state => state.settings[field], listener),
	getValue: (store: UpgradesStore): number => store.getState().settings[field] ?? 0,
});

/** A read of the tab's run state, the way `useBulkState` reads the Bulk tab's slice. */
export const useUpgradesStore = <T>(selector: (state: UpgradesState) => T): T => useStore(useUpgradesStoreApi(), selector);
