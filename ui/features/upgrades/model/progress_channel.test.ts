import type { Player } from '@sim/player/player';
import { describe, expect, it, vi } from 'vitest';

import { clearProgress, emitProgress, progressOf, subscribeProgress } from './progress_channel';
import type { RunProgressView } from './run_progress';

const view = (done: number): RunProgressView => ({
	phase: 'candidates',
	stage: 'simming',
	done,
	total: 10,
	boundary: 9,
	concurrency: 4,
	qualifyingRows: 0,
});

describe('progress channel', () => {
	it('has no snapshot before the first tick', () => {
		expect(progressOf({} as Player<any>)).toBeNull();
	});

	it('hands each tick to every subscriber and keeps the last one', () => {
		const player = {} as Player<any>;
		const first = vi.fn();
		const second = vi.fn();
		subscribeProgress(player, first);
		subscribeProgress(player, second);
		emitProgress(player, view(2));
		expect(first).toHaveBeenCalledWith(view(2));
		expect(second).toHaveBeenCalledWith(view(2));
		expect(progressOf(player)).toEqual(view(2));
	});

	it('stops calling a listener after it unsubscribes', () => {
		const player = {} as Player<any>;
		const listener = vi.fn();
		const unsubscribe = subscribeProgress(player, listener);
		unsubscribe();
		emitProgress(player, view(1));
		expect(listener).not.toHaveBeenCalled();
	});

	it('clears the last run’s snapshot at the start of a run and keeps the subscribers', () => {
		const player = {} as Player<any>;
		const listener = vi.fn();
		subscribeProgress(player, listener);
		emitProgress(player, view(7));
		clearProgress(player);
		expect(progressOf(player)).toBeNull();
		emitProgress(player, view(1));
		expect(listener).toHaveBeenLastCalledWith(view(1));
	});

	it('keeps each player’s ticks apart', () => {
		const one = {} as Player<any>;
		const two = {} as Player<any>;
		const listener = vi.fn();
		subscribeProgress(two, listener);
		emitProgress(one, view(3));
		expect(listener).not.toHaveBeenCalled();
		expect(progressOf(two)).toBeNull();
	});
});
