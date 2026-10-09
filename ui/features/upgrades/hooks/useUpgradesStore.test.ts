import { Spec } from '@generated/proto/common';
import { batch } from '@sim/state/batch';
import { fakeHost } from '@sim/testing';
import { describe, expect, it, vi } from 'vitest';

import { createUpgradesStore, dispatchSettings, setSort } from '../model/upgrades_store';
import { numberSettingSource, upgradesStoreFor } from './useUpgradesStore';

describe('upgradesStoreFor', () => {
	const storage = new Map<string, string>();
	const env = {
		storage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
			removeItem: () => {},
		},
	};
	// A new `Sim` is a page load; the spec prefix is upstream's `specStorageKey`. SpecUnknown has no ranking data, so no phase subscription is made.
	const pageFor = (specPrefix: string) =>
		upgradesStoreFor(fakeHost({ sim: { env }, player: { getSpec: () => Spec.SpecUnknown }, getStorageKey: (part: string) => specPrefix + part }));

	it('keeps the settings and sort per spec across page loads, as upstream keys saved settings by spec', () => {
		const feral = pageFor('__tbc_new_feral_druid');
		dispatchSettings(feral, { type: 'setIterations', iterations: 4321 });
		setSort(feral, [{ id: 'source', desc: true }]);

		expect(storage.has('__tbc_new_feral_druid__upgradesSettings__')).toBe(true);
		const feralReloaded = pageFor('__tbc_new_feral_druid').getState();
		expect(feralReloaded.settings.iterations).toBe(4321);
		expect(feralReloaded.sort).toEqual([{ id: 'source', desc: true }]);

		const ret = pageFor('__tbc_new_retribution_paladin').getState();
		expect(ret.settings.iterations).not.toBe(4321);
		expect(ret.sort).toEqual([]);
	});
});

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
