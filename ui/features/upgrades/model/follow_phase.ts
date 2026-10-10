import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import { poolFor } from './data/data';
import type { ContentPhase } from './engine/types';
import { followPhaseChanges } from './phase_changes';
import { specIdFor } from './run';
import { validSourceKeysOf } from './settings_pool';
import { dispatchSettings, type UpgradesStore } from './upgrades_store';

/**
 * A phase change sends the settings back to the new phase's default sets, as
 * every phase change did on the old tab, whether or not the tab is on screen
 * (ticket 564, review K2-1). The changes come from the page's record
 * (`phase_changes.ts`), so one made before this store existed is replayed in
 * order (ticket 587). A store subscription for the page's lifetime, as
 * `initBulk` keeps the Bulk batch in step with the gear, so no render writes
 * the store. A spec with no ranking data has no defaults to go back to.
 *
 * Once the page has loaded, an exclusion the page's pool no longer offers is
 * dropped, so a saved key that a data update removed is not counted as
 * excluded (ticket 587, D2).
 */
export function followPhase(store: UpgradesStore, { sim, player }: IndividualSimHost<Spec>): void {
	const specId = specIdFor(player.getSpec());
	if (!specId) return;
	const sourcesAt = (phase: number) => validSourceKeysOf(poolFor(specId, phase as ContentPhase));
	followPhaseChanges(sim, phase => dispatchSettings(store, { type: 'scopeChanged', validSourceKeys: sourcesAt(phase) }));
	void sim.waitForInit().then(() => dispatchSettings(store, { type: 'dropUnofferedSources', validSourceKeys: sourcesAt(sim.getPhase()) }));
}
