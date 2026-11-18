import type { Spec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import { poolFor } from './data/data';
import type { ContentPhase } from './engine/types';
import { followPhaseChanges } from './phase_changes';
import { specIdFor } from './run';
import { poolSourceKeysOf } from './settings_pool';
import type { UpgradesStore } from './upgrades_store';

/**
 * Resets the settings to each new phase's default sets for the page's lifetime,
 * whether or not the tab is on screen, as `initBulk` follows the gear, so no render
 * writes the store. Once the page loads, a saved exclusion the pool no longer
 * offers is dropped, so it is not counted.
 */
export function followPhase(store: UpgradesStore, host: IndividualSimHost<Spec>): void {
	const { sim, player } = host;
	const specId = specIdFor(player.getSpec());
	if (!specId) return;
	const sourcesAt = (phase: number) => poolSourceKeysOf(poolFor(host, host.individualConfig.presets.gear, phase as ContentPhase));
	followPhaseChanges(host, phase => store.getState().changeScope(sourcesAt(phase)));
	void sim.waitForInit().then(() => store.getState().dropUnofferedSources(sourcesAt(sim.getPhase())));
}
