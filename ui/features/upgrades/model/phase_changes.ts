/**
 * The page's phase changes, from the moment its saved settings have loaded, for the Upgrades tab: a phase change
 * resets the tab to that phase's default sets whether or not the tab is on screen (ticket 564). Small and free of the
 * tab's code and data on purpose: the eager `UpgradesTabBody` starts the watch at page start, and a page whose tab
 * never opens must download neither (tickets 587, 589).
 */

import type { Spec } from '@generated/proto/common';
import type { Sim } from '@sim/sim';
import type { IndividualSimHost } from '@sim/sim_host';
import { subscribeSimField } from '@sim/state/subscriptions';

import { forgetSavedSets, UPGRADES_SETTINGS_STORAGE_KEY } from './saved_entry';

type Follower = (phase: number) => void;

/** Each watched page's tab store follower, once the store exists. */
const watches = new WeakMap<Sim, { follower?: Follower }>();

/**
 * Starts watching the page's phase, once per page. Until a tab store follows the phase, a change is saved straight
 * into the tab's saved entry (`forgetSavedSets`), so the store, made later from that entry, starts from the new
 * phase's defaults. The watch starts after `waitForInit`: the page queues its settings load on that promise before any
 * tab code runs (`app/individual_sim_ui.tsx`), so the load's own phase write is the saved phase coming back, not a change.
 */
export function watchPhaseChanges(host: IndividualSimHost<Spec>): void {
	const { sim } = host;
	if (watches.has(sim)) return;
	const watch: { follower?: Follower } = {};
	watches.set(sim, watch);
	const onPhaseChange = () => {
		if (watch.follower) watch.follower(sim.getPhase());
		else forgetSavedSets(sim.env.storage, host.getStorageKey(UPGRADES_SETTINGS_STORAGE_KEY));
	};
	void sim.waitForInit().then(() => subscribeSimField(sim, 'phase')(onPhaseChange));
}

/** Hands `follower` each later phase change on the page, in place of the saved entry. One follower per page. */
export function followPhaseChanges(host: IndividualSimHost<Spec>, follower: Follower): void {
	watchPhaseChanges(host);
	watches.get(host.sim)!.follower = follower;
}
