import { Spec } from '@generated/proto/common';
import { batch } from '@sim/state/batch';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { describe, expect, it, vi } from 'vitest';

import { poolFor } from '../model/data/data';
import { UPGRADES_SETTINGS_STORAGE_KEY } from '../model/saved_entry';
import { validSourceKeysOf } from '../model/settings_pool';
import { createUpgradesStore } from '../model/upgrades_store';
import { fakeTabHost, memoryStorage, settled } from '../testing/fake_tab_host';
import { numberSettingSource, upgradesStoreFor } from './useUpgradesStore';

describe('upgradesStoreFor', () => {
	const storage = memoryStorage();
	// A new `Sim` is a page load; the spec prefix is upstream's `specStorageKey`. SpecUnknown has no ranking data, so no phase subscription is made.
	const pageFor = (specPrefix: string) =>
		upgradesStoreFor(
			fakeTabHost({ sim: { env: { storage } }, player: { getSpec: () => Spec.SpecUnknown }, getStorageKey: (part: string) => specPrefix + part }),
		);

	it('keeps the settings and sort per spec across page loads, as upstream keys saved settings by spec', () => {
		const feral = pageFor('__tbc_new_feral_druid');
		feral.getState().setIterations(4321, undefined);
		feral.getState().setSort([{ id: 'source', desc: true }]);

		expect(storage.entries.has('__tbc_new_feral_druid__upgradesSettings__')).toBe(true);
		const feralReloaded = pageFor('__tbc_new_feral_druid').getState();
		expect(feralReloaded.settings.iterations).toBe(4321);
		expect(feralReloaded.sort).toEqual([{ id: 'source', desc: true }]);

		const ret = pageFor('__tbc_new_retribution_paladin').getState();
		expect(ret.settings.iterations).not.toBe(4321);
		expect(ret.sort).toEqual([]);
	});
});

describe('upgradesStoreFor and the page’s phase (ticket 587)', () => {
	const KEY = `__upgrades_test${UPGRADES_SETTINGS_STORAGE_KEY}`;
	const savedSettings = (settings: object) => ({ [KEY]: JSON.stringify({ version: 1, settings }) });

	/**
	 * A ret page over `storage` at `phase`, whose sim finishes its start-up when the test calls `finishInit`. `load`
	 * is the page's own settings load, which the page queues on that start-up before any tab code runs
	 * (`app/individual_sim_ui.tsx`, `waitForInit().then(... loadSettings())`).
	 */
	const retPage = (storage: ReturnType<typeof memoryStorage>, phase: number, load?: (setPhase: (phase: number) => void) => void) => {
		const simStore = createSimStore();
		const setPhase = (next: number) => patchSlice(simStore, 'sim', { phase: next });
		setPhase(phase);
		let finish!: () => void;
		const init = new Promise<void>(resolve => (finish = resolve));
		if (load) void init.then(() => load(setPhase));
		const sim = { store: simStore, env: { storage }, waitForInit: () => init, getPhase: () => simStore.getState().sim.phase };
		const host = fakeTabHost({ sim, player: { getSpec: () => Spec.SpecRetributionPaladin } });
		const finishInit = async () => {
			finish();
			await settled();
		};
		return { host, setPhase, finishInit };
	};

	it('keeps the restored sets when the tab opens before the page has loaded its saved phase (A3)', async () => {
		const storage = memoryStorage(savedSettings({ selectedSetKeys: ['preset:4:P4'], defaultsFor: 'ret:4' }));
		const page = retPage(storage, 3, setPhase => setPhase(4));
		const store = upgradesStoreFor(page.host);

		await page.finishInit();

		expect(store.getState().settings).toMatchObject({ selectedSetKeys: ['preset:4:P4'], defaultsFor: 'ret:4' });
	});

	it('saves a phase change, so a reload at the new phase starts from that phase’s defaults (A4)', async () => {
		const storage = memoryStorage();
		const first = retPage(storage, 3);
		const store = upgradesStoreFor(first.host);
		await first.finishInit();
		// A write with a scope is what stores that scope's defaults, as in production.
		store.getState().setPrune(true, { key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] });
		first.setPhase(4);

		const reloaded = retPage(storage, 4);
		const settings = upgradesStoreFor(reloaded.host).getState().settings;
		expect(settings.selectedSetKeys).toEqual([]);
		expect(settings.defaultsFor).toBeUndefined();
	});

	it('drops a saved exclusion the page’s pool no longer offers once the page has loaded (D2)', async () => {
		const offered = validSourceKeysOf(poolFor('ret', 3))[0]!;
		const storage = memoryStorage(savedSettings({ excludedSources: [offered, 'A zone a data update removed'], defaultsFor: 'ret:3' }));
		const page = retPage(storage, 3);
		const store = upgradesStoreFor(page.host);

		await page.finishInit();

		expect(store.getState().settings.excludedSources).toEqual([offered]);
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
			store.getState().setIterations(2000, undefined);
			store.getState().setIterations(3000, undefined);
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
			store.getState().setIterations(2000, undefined);
			unsubscribe();
		});

		expect(listener).not.toHaveBeenCalled();
	});
});
