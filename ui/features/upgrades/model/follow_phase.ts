import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeSimField } from '@sim/state/subscriptions';

import { poolFor } from './data/data';
import type { ContentPhase } from './engine/types';
import { specIdFor } from './run';
import { validSourceKeysOf } from './settings_pool';
import { dispatchSettings, type UpgradesStore } from './upgrades_store';

/**
 * A phase change sends the settings back to the new phase's default sets, as
 * every phase change did on the old tab, whether or not the tab is on screen
 * (ticket 564, review K2-1). A store subscription for the page's lifetime, as
 * `initBulk` keeps the Bulk batch in step with the gear, so no render writes
 * the store. A spec with no ranking data has no defaults to go back to.
 */
export function followPhase(store: UpgradesStore, { sim, player }: IndividualSimHost<Spec>): void {
	const specId = specIdFor(player.getSpec());
	if (!specId) return;
	const onPhaseChange = subscribeSimField(sim, 'phase');
	onPhaseChange(() => {
		const validSourceKeys = validSourceKeysOf(poolFor(specId, sim.getPhase() as ContentPhase));
		dispatchSettings(store, { type: 'scopeChanged', validSourceKeys });
	});
}
