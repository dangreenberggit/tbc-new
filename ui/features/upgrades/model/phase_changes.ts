/**
 * The page's phase changes, recorded from the moment its saved settings have
 * loaded, for the tab's store to follow (ticket 587). Small and free of the
 * tab's data on purpose: the eager `UpgradesTabBody` starts the record at page
 * start, before the tab's code is downloaded, so a phase change made before
 * the tab opens is not lost.
 */

import type { Sim } from '@sim/sim';
import { subscribeSimField } from '@sim/state/subscriptions';

type Follower = (phase: number) => void;
type PhaseRecord = { missed: number[]; follower?: Follower; onMissed?: () => void };

const records = new WeakMap<Sim, PhaseRecord>();

/**
 * Starts recording the page's phase changes, once per page. The record starts
 * after `waitForInit`: the page queues its settings load on that promise before
 * any tab code runs (`app/individual_sim_ui.tsx`), so the load's own phase write
 * is the saved phase coming back, not a change. `onMissed` runs on each change
 * that no store follows yet.
 */
export function watchPhaseChanges(sim: Sim, onMissed?: () => void): void {
	if (records.has(sim)) return;
	const record: PhaseRecord = { missed: [], onMissed };
	records.set(sim, record);
	const onPhaseChange = () => {
		const phase = sim.getPhase();
		if (record.follower) {
			record.follower(phase);
		} else {
			record.missed.push(phase);
			record.onMissed?.();
		}
	};
	void sim.waitForInit().then(() => subscribeSimField(sim, 'phase')(onPhaseChange));
}

/** Hands `follower` each phase change recorded so far, in order, and then each later one. One follower per page. */
export function followPhaseChanges(sim: Sim, follower: Follower): void {
	watchPhaseChanges(sim);
	const record = records.get(sim)!;
	record.follower = follower;
	const missed = record.missed;
	record.missed = [];
	missed.forEach(follower);
}
