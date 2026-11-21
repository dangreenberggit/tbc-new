import type { Spec } from '@generated/proto/common';
import { useSimHost } from '@sim/context/SimHostContext';
import type { Sim } from '@sim/sim';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeGated } from '@sim/state/batch';
import type { StoreSubscribe } from '@sim/state/subscriptions';
import { useStore } from 'zustand';

import { followPhase } from '../model/follow_phase';
import { TAB_DEFAULT_ITERATIONS } from '../model/run_state';
import { UPGRADES_SETTINGS_STORAGE_KEY } from '../model/saved_entry';
import { openSavedUpgradesStore } from '../model/saved_settings';
import type { InitialSettings, UpgradesState, UpgradesStore } from '../model/upgrades_store';

export { selectRun, selectRunStatus, selectSettledSignature, selectSort } from '../model/upgrades_store';

const INITIAL_SETTINGS: InitialSettings = { iterations: TAB_DEFAULT_ITERATIONS };

const stores = new WeakMap<Sim, UpgradesStore>();

/**
 * The Upgrades tab's store for a page, one per `Sim` as the sim store is, found from
 * the host with no provider and created by the first reader. That reader is usually
 * a render, which then also subscribes the store to phase changes for the page's
 * lifetime (`followPhase`); it writes no state, and the `WeakMap` hands a repeated
 * render (StrictMode) the same store. The store goes in the map before `followPhase`
 * runs, so a render React discards still leaves the one store the next render finds.
 * It starts from what this spec's page saved last, as the sim's own settings do.
 */
export function upgradesStoreFor(host: IndividualSimHost<Spec>): UpgradesStore {
	let store = stores.get(host.sim);
	if (!store) {
		store = openSavedUpgradesStore(INITIAL_SETTINGS, host.sim.env.storage, host.getStorageKey(UPGRADES_SETTINGS_STORAGE_KEY));
		stores.set(host.sim, store);
		followPhase(store, host);
	}
	return store;
}

export const useUpgradesStoreApi = (): UpgradesStore => upgradesStoreFor(useSimHost());

/**
 * A number picker's subscription and read for one tab setting. It notifies on that
 * field alone, so a row a run finishes does not rewrite the field. Writes go through
 * `useUpgradesSettings`, which applies the scope's default gear sets first. Gated like
 * the sim's own pickers (`subscriptions.ts` `fromSelector`), so a write inside
 * `batch()` notifies once, at the batch's end.
 */
export const numberSettingSource = (field: 'iterations') => ({
	storeSubscribe:
		(store: UpgradesStore): StoreSubscribe =>
		listener =>
			subscribeGated(store.subscribe, state => state.settings[field], listener),
	getValue: (store: UpgradesStore): number => store.getState().settings[field],
});

/** A read of the tab's store, the way `useBulkState` reads the Bulk tab's slice. */
export const useUpgradesStore = <T>(selector: (state: UpgradesState) => T): T => useStore(useUpgradesStoreApi(), selector);
