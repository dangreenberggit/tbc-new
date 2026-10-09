import { batch } from '@sim/state/batch';
import { describe, expect, it, vi } from 'vitest';

import { createUpgradesStore, dispatchSettings } from '../model/upgrades_store';
import { numberSettingSource } from './useUpgradesStore';

describe('numberSettingSource', () => {
	it('rings once, at the end of a batch, however many writes the batch makes', () => {
		const store = createUpgradesStore({ iterations: 1000 });
		const listener = vi.fn();
		const unsubscribe = numberSettingSource('iterations').storeSubscribe(store)(listener);

		// `batch` logs an error thrown inside it rather than throwing, so the count is read here and asserted after.
		let callsInBatch = -1;
		batch(() => {
			dispatchSettings(store, { type: 'setIterations', iterations: 2000 });
			dispatchSettings(store, { type: 'setIterations', iterations: 3000 });
			callsInBatch = listener.mock.calls.length;
		});

		expect(callsInBatch).toBe(0);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(numberSettingSource('iterations').getValue(store)).toBe(3000);
		unsubscribe();
	});

	it('does not ring after unsubscribe for a write queued in a batch', () => {
		const store = createUpgradesStore({ iterations: 1000 });
		const listener = vi.fn();
		const unsubscribe = numberSettingSource('iterations').storeSubscribe(store)(listener);

		batch(() => {
			dispatchSettings(store, { type: 'setIterations', iterations: 2000 });
			unsubscribe();
		});

		expect(listener).not.toHaveBeenCalled();
	});
});
