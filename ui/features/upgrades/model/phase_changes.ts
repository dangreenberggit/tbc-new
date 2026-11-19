/**
 * Watches the page's phase once its saved settings load, so a phase change resets the tab to that phase's default
 * gear sets whether or not the tab is on screen. Free of the tab's code and data on purpose: `UpgradesTabBody` starts the
 * watch at page start, and a page whose tab never opens must download neither.
 */

import type { Spec } from '@generated/proto/common';
import type { Sim } from '@sim/sim';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeSimField } from '@sim/state/subscriptions';

import { forgetSelectedGearSets, UPGRADES_SETTINGS_STORAGE_KEY } from './saved_entry';

type Follower = (phase: number) => void;

/** Each watched page's tab store follower, once the store exists. */
const watches = new WeakMap<Sim, { follower?: Follower }>();

/**
 * Starts watching the page's phase, once per page. Until a tab store follows, a change goes straight into the saved
 * entry (`forgetSelectedGearSets`), so the store made later from it starts from the new phase's defaults. The watch starts
 * after `waitForInit`, on which the page queues its settings load (`app/individual_sim_ui.tsx`), so the load's own
 * phase write is not taken for a change.
 */
export function watchPhaseChanges(host: IndividualSimHost<Spec>): void {
	const { sim } = host;
	if (watches.has(sim)) return;
	const watch: { follower?: Follower } = {};
	watches.set(sim, watch);
	const onPhaseChange = () => {
		if (watch.follower) watch.follower(sim.getPhase());
		else forgetSelectedGearSets(sim.env.storage, host.getStorageKey(UPGRADES_SETTINGS_STORAGE_KEY));
	};
	void sim.waitForInit().then(() => subscribeSimField(sim, 'phase')(onPhaseChange));
}

/** Hands `follower` each later phase change on the page, in place of the saved entry. One follower per page. */
export function followPhaseChanges(host: IndividualSimHost<Spec>, follower: Follower): void {
	watchPhaseChanges(host);
	watches.get(host.sim)!.follower = follower;
}
