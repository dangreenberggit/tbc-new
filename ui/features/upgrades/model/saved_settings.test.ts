import type { Env } from '@sim/state/env';
import { describe, expect, it } from 'vitest';

import { memoryStorage } from '../testing/fake_tab_host';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { openSavedUpgradesStore } from './saved_settings';
import { dispatchRun, dispatchSettings, setExportFlavour, setSort, setViewToggle } from './upgrades_store';

const KEY = '__tbc_new_feral_druid__upgradesSettings__';
const SEED = { iterations: 1000 };

describe('openSavedUpgradesStore', () => {
	it('restores the settings and the sort a user chose in a fresh store', () => {
		const storage = memoryStorage();
		const first = openSavedUpgradesStore(SEED, storage, KEY);
		dispatchSettings(first, { type: 'setIterations', iterations: 5000 });
		dispatchSettings(first, { type: 'toggleSource', key: 'raid:hyjal' });
		dispatchSettings(first, { type: 'applyDefaults', key: 'feral:3', selectedSetKeys: ['preset:P3'], validSourceKeys: ['raid:hyjal'] });
		dispatchSettings(first, { type: 'setPrune', prune: true });
		setSort(first, [{ id: 'slot', desc: false }]);

		const reloaded = openSavedUpgradesStore(SEED, storage, KEY);

		expect(reloaded.getState().settings).toEqual({
			excludedSources: ['raid:hyjal'],
			selectedSetKeys: ['preset:P3'],
			prune: true,
			iterations: 5000,
			defaultsFor: 'feral:3',
		});
		expect(reloaded.getState().sort).toEqual([{ id: 'slot', desc: false }]);
	});

	it('restores the view toggles a user set in a fresh store', () => {
		const storage = memoryStorage();
		const first = openSavedUpgradesStore(SEED, storage, KEY);
		setViewToggle(first, 'withSetPotential', true);
		setViewToggle(first, 'onlyBis', true);
		setViewToggle(first, 'withSetPotential', false);

		expect(openSavedUpgradesStore(SEED, storage, KEY).getState().view).toEqual({ withSetPotential: false, onlyBis: true });
	});

	it('restores the export panel’s token or gear choice in a fresh store (ticket 588)', () => {
		const storage = memoryStorage();
		setExportFlavour(openSavedUpgradesStore(SEED, storage, KEY), 'gear');
		expect(openSavedUpgradesStore(SEED, storage, KEY).getState().exportFlavour).toBe('gear');
	});

	it('restores token for an entry saved before the export choice was', () => {
		const raw = JSON.stringify({ version: 1, settings: { iterations: 5000 }, view: { onlyBis: true } });
		const state = openSavedUpgradesStore(SEED, memoryStorage({ [KEY]: raw }), KEY).getState();
		expect(state.exportFlavour).toBe('token');
		expect(state.view.onlyBis).toBe(true);
	});

	it('restores a version-1 entry saved before the view toggles were, with the toggles off', () => {
		const raw = JSON.stringify({ version: 1, settings: { iterations: 5000 }, sort: [{ id: 'slot', desc: true }] });
		const state = openSavedUpgradesStore(SEED, memoryStorage({ [KEY]: raw }), KEY).getState();
		expect(state.settings.iterations).toBe(5000);
		expect(state.sort).toEqual([{ id: 'slot', desc: true }]);
		expect(state.view).toEqual({ withSetPotential: false, onlyBis: false });
	});

	it('lets the dev link’s iterations win over the saved ones, as a settings link wins over saved settings upstream', () => {
		const storage = memoryStorage();
		const first = openSavedUpgradesStore(SEED, storage, KEY);
		dispatchSettings(first, { type: 'setIterations', iterations: 5000 });

		expect(openSavedUpgradesStore(SEED, storage, KEY, { iterations: 300 }).getState().settings.iterations).toBe(300);
	});

	// The cap picker shows only on a page with `?upgrades-dev` (ticket 466), so a cap that came back on another page would cut the run unseen (ticket 586).
	it('restores no cap: a page without the dev link runs uncapped whatever a dev page set', () => {
		const storage = memoryStorage({ [KEY]: JSON.stringify({ version: 1, settings: { candidateCap: 25 } }) });
		const devPage = openSavedUpgradesStore(SEED, storage, KEY, { candidateCap: 3 });
		expect(devPage.getState().settings.candidateCap).toBe(3);
		dispatchSettings(devPage, { type: 'setCandidateCap', cap: 7 });
		dispatchSettings(devPage, { type: 'setIterations', iterations: 2000 });

		const plainPage = openSavedUpgradesStore(SEED, storage, KEY).getState().settings;
		expect(plainPage.iterations).toBe(2000);
		expect(plainPage.candidateCap).toBeUndefined();
	});

	it('stores nothing from a run', () => {
		const storage = memoryStorage();
		const store = openSavedUpgradesStore(SEED, storage, KEY);
		dispatchRun(store, { type: 'started', runId: 1, startedAt: 1000, measuredOn: { inputsSignature: 'sig' } });
		dispatchRun(store, { type: 'landed', runId: 1, row: RANKING_FIXTURE.items[0]! });
		expect(storage.entries.has(KEY)).toBe(false);

		dispatchSettings(store, { type: 'setIterations', iterations: 2000 });
		const stored = JSON.parse(storage.entries.get(KEY)!);
		expect(Object.keys(stored).sort()).toEqual(['exportFlavour', 'settings', 'sort', 'version', 'view']);
		expect(JSON.stringify(stored)).not.toContain('sig');
	});

	describe('falls back to the defaults without throwing', () => {
		const DEFAULT_STATE = {
			settings: { excludedSources: [], selectedSetKeys: [], prune: false, iterations: 1000 },
			sort: [],
			view: { withSetPotential: false, onlyBis: false },
			exportFlavour: 'token',
		};
		const restoredFrom = (raw: string | undefined) => {
			const store = openSavedUpgradesStore(SEED, memoryStorage(raw === undefined ? {} : { [KEY]: raw }), KEY);
			const { settings, sort, view, exportFlavour } = store.getState();
			return { settings, sort, view, exportFlavour };
		};
		const saved = (body: object) => JSON.stringify({ version: 1, ...body });

		it.each([
			['nothing stored', undefined],
			['text that is not JSON', '{oops'],
			['JSON null', 'null'],
			['a bare number', '42'],
			['an array', '[]'],
			['another version', JSON.stringify({ version: 2, settings: { iterations: 5000 }, sort: [{ id: 'slot', desc: true }] })],
			['no version', JSON.stringify({ settings: { iterations: 5000 }, sort: [{ id: 'slot', desc: true }] })],
			['settings that are not an object', saved({ settings: 'x', sort: 'y' })],
		])('for %s', (_case, raw) => {
			expect(restoredFrom(raw)).toEqual(DEFAULT_STATE);
		});

		it('per field, keeping every field that reads back valid', () => {
			const raw = saved({
				settings: {
					iterations: '5000',
					candidateCap: -3,
					prune: 'yes',
					excludedSources: ['raid:hyjal', 7],
					selectedSetKeys: ['preset:P3'],
					defaultsFor: 'feral:3',
				},
				sort: [{ id: 'slot', desc: true }],
				view: { withSetPotential: 'yes', onlyBis: true },
				exportFlavour: 'pdf',
			});
			expect(restoredFrom(raw)).toEqual({
				settings: { ...DEFAULT_STATE.settings, selectedSetKeys: ['preset:P3'], defaultsFor: 'feral:3' },
				sort: [{ id: 'slot', desc: true }],
				view: { withSetPotential: false, onlyBis: true },
				exportFlavour: 'token',
			});
		});

		it.each([
			['a column the table does not have', [{ id: 'gone', desc: true }]],
			[
				'two columns, when the table sorts on one',
				[
					{ id: 'slot', desc: true },
					{ id: 'item', desc: false },
				],
			],
			['a direction that is not a boolean', [{ id: 'slot', desc: 'yes' }]],
		])('for a sort naming %s', (_case, sort) => {
			expect(restoredFrom(saved({ sort })).sort).toEqual([]);
		});

		it('when the storage itself throws', () => {
			const blocked: Env['storage'] = {
				getItem: () => {
					throw new Error('blocked');
				},
				setItem: () => {
					throw new Error('blocked');
				},
				removeItem: () => {},
			};
			const store = openSavedUpgradesStore(SEED, blocked, KEY);
			expect(() => dispatchSettings(store, { type: 'setIterations', iterations: 2000 })).not.toThrow();
			expect(store.getState().settings.iterations).toBe(2000);
		});
	});
});
