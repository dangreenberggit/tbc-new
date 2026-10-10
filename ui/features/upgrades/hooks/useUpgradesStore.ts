import type { Spec } from '@generated/proto/common';
import { useSimHost } from '@sim/context/SimHostContext';
import type { Sim } from '@sim/sim';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeGated } from '@sim/state/batch';
import type { StoreSubscribe } from '@sim/state/subscriptions';
import { useStore } from 'zustand';

import { followPhase } from '../model/follow_phase';
import { DEFAULT_ITERATIONS } from '../model/run_reducer';
import { UPGRADES_SETTINGS_STORAGE_KEY } from '../model/saved_entry';
import { type LinkedSettings, openSavedUpgradesStore } from '../model/saved_settings';
import type { SettingsSeed, UpgradesState, UpgradesStore } from '../model/upgrades_store';
import { DEV_FLAGS } from '../utils/dev_flags';

export { selectRun, selectRunStatus, selectSettledSignature, selectSort } from '../model/upgrades_store';

const SETTINGS_SEED: SettingsSeed = { iterations: DEFAULT_ITERATIONS };

/** The dev link's iterations and cap, read once per page load; a field the link leaves out is absent, so the saved iterations stand and no cap is set. */
const DEV_LINK: LinkedSettings = {
	...(DEV_FLAGS.iterations !== undefined && { iterations: DEV_FLAGS.iterations }),
	...(DEV_FLAGS.cap !== undefined && { candidateCap: DEV_FLAGS.cap }),
};

const stores = new WeakMap<Sim, UpgradesStore>();

/**
 * The Upgrades tab's store for a page, one per `Sim` as upstream keeps one sim
 * store per `Sim` (ticket 564). Any reader on the page finds it from the host
 * it already has, with no provider; the first reader creates it. That reader is
 * usually a render, so the render that creates the store also installs the
 * page-lifetime phase subscription (`followPhase`); it writes no state, and the
 * `WeakMap` hands a repeated render (StrictMode) the same store. The store is
 * in the map before `followPhase` runs, so a render React discards before
 * commit leaves the one store the next render for that `Sim` finds. The store
 * starts from what this spec's page saved last, under the spec's key as
 * upstream saves the sim's own settings.
 */
export function upgradesStoreFor(host: IndividualSimHost<Spec>): UpgradesStore {
	let store = stores.get(host.sim);
	if (!store) {
		store = openSavedUpgradesStore(SETTINGS_SEED, host.sim.env.storage, host.getStorageKey(UPGRADES_SETTINGS_STORAGE_KEY), DEV_LINK);
		stores.set(host.sim, store);
		followPhase(store, host);
	}
	return store;
}

export const useUpgradesStoreApi = (): UpgradesStore => upgradesStoreFor(useSimHost());

/**
 * A number picker's change source and read for one tab setting, with the tab
 * store as its model. It rings on that field alone, so a row a run lands does
 * not rewrite the field. Writes go through `useUpgradesSettings`, which
 * applies the scope's default sets first. Gated like every upstream picker
 * source (`subscriptions.ts` `fromSelector`), so a write inside `batch()` rings
 * once, at the batch's end.
 */
export const numberSettingSource = (field: 'iterations' | 'candidateCap') => ({
	storeSubscribe:
		(store: UpgradesStore): StoreSubscribe =>
		listener =>
			subscribeGated(store.subscribe, state => state.settings[field], listener),
	getValue: (store: UpgradesStore): number => store.getState().settings[field] ?? 0,
});

/** A read of the tab's run state, the way `useBulkState` reads the Bulk tab's slice. */
export const useUpgradesStore = <T>(selector: (state: UpgradesState) => T): T => useStore(useUpgradesStoreApi(), selector);
