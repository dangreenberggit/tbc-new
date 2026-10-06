/**
 * The Upgrades run's progress ticks, per player, outside React state: a tick
 * renders only the progress bar that subscribes to it, never the tab. The
 * same split as upstream's Bulk run (`features/bulk/model/run.ts`,
 * `subscribeBulkProgress`).
 */

import type { Player } from '@sim/player/player';

import type { RunProgressView } from './run_progress';

type ProgressListener = (view: RunProgressView) => void;

type Channel = {
	snapshot: RunProgressView | null;
	listeners: Set<ProgressListener>;
};

// `Player<SpecType extends Spec>` has no default type argument, and the
// channel serves every spec.
const channels = new WeakMap<Player<any>, Channel>();

const channelOf = (player: Player<any>): Channel => {
	let channel = channels.get(player);
	if (!channel) {
		channel = { snapshot: null, listeners: new Set() };
		channels.set(player, channel);
	}
	return channel;
};

export const progressOf = (player: Player<any>): RunProgressView | null => channelOf(player).snapshot;

export const subscribeProgress = (player: Player<any>, listener: ProgressListener): (() => void) => {
	const { listeners } = channelOf(player);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export const emitProgress = (player: Player<any>, view: RunProgressView): void => {
	const channel = channelOf(player);
	channel.snapshot = view;
	for (const listener of channel.listeners) listener(view);
};

/** Called as a run starts, so the dialog never opens on the last run's final tick. */
export const clearProgress = (player: Player<any>): void => {
	channelOf(player).snapshot = null;
};
