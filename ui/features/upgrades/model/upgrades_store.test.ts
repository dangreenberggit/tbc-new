import { describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { PartialRanking } from './engine/rank';
import { appliedSettings } from './settings_state';
import { createUpgradesStore, selectHiddenSources, selectRunStatus, selectSettledSignature, selectSort } from './upgrades_store';

const [rowA] = RANKING_FIXTURE.items;
const SEED = { iterations: 1000 };
const SCOPE = { key: 'ret:3', selectedSetKeys: ['preset:P3'], validSourceKeys: ['raid:hyjal'] };
const MEASURED = { inputsSignature: 'sig-at-click' };

describe('createUpgradesStore', () => {
	it('starts idle with the seed as the settings', () => {
		const store = createUpgradesStore(SEED);
		expect(selectRunStatus(store.getState())).toBe('idle');
		expect(store.getState().settings).toEqual({ excludedSources: [], selectedSetKeys: [], prune: false, iterations: 1000 });
	});
});

describe('the run actions', () => {
	it('notifies nobody when a superseded run lands a row', () => {
		const store = createUpgradesStore(SEED);
		store.getState().startRun(2, 1000);
		const listener = vi.fn();
		store.subscribe(listener);

		store.getState().landRow(1, rowA!);
		expect(listener).not.toHaveBeenCalled();

		store.getState().landRow(2, rowA!);
		expect(listener).toHaveBeenCalledOnce();
		expect(store.getState().run).toMatchObject({ status: 'running', landedRows: [rowA] });
	});

	it('keeps the sort the user chose when the next run starts and lands', () => {
		const store = createUpgradesStore(SEED);
		store.getState().startRun(1, 1000);
		store.getState().settleRun(1, RANKING_FIXTURE);
		store.getState().setSort([{ id: 'item', desc: false }]);

		store.getState().startRun(2, 2000);
		expect(selectSort(store.getState())).toEqual([{ id: 'item', desc: false }]);

		store.getState().landRow(2, rowA!);
		store.getState().settleRun(2, RANKING_FIXTURE);
		expect(selectSort(store.getState())).toEqual([{ id: 'item', desc: false }]);
	});

	it('keeps the sort when a recorded ranking loads', () => {
		const store = createUpgradesStore(SEED);
		store.getState().setSort([{ id: 'item', desc: false }]);

		store.getState().loadFixture(1, RANKING_FIXTURE);

		expect(selectSort(store.getState())).toEqual([{ id: 'item', desc: false }]);
	});

	it('starts a new run from a finished one, keeping none of its rows or what it was measured on', () => {
		const store = createUpgradesStore(SEED);
		store.getState().startRun(1, 1000, MEASURED);
		store.getState().landRow(1, rowA!);
		store.getState().settleRun(1, RANKING_FIXTURE);

		store.getState().startRun(2, 5000);
		expect(store.getState().run).toEqual({ status: 'running', runId: 2, startedAt: 5000, landedRows: [], stopping: false });
	});

	it('leaves the settings object alone', () => {
		const store = createUpgradesStore(SEED);
		const settings = store.getState().settings;
		store.getState().startRun(1, 1000);
		expect(store.getState().settings).toBe(settings);
	});
});

describe('appliedSettings', () => {
	it('applies the scope defaults to a fresh state and returns the same object on a second call', () => {
		const store = createUpgradesStore(SEED);
		const raw = store.getState().settings;
		const first = appliedSettings(raw, SCOPE);
		expect(first).toMatchObject({ selectedSetKeys: ['preset:P3'], defaultsFor: 'ret:3' });
		expect(raw.defaultsFor).toBeUndefined();
		expect(appliedSettings(first, SCOPE)).toBe(first);
	});

	it('returns the stored object once a write has stored the defaults', () => {
		const store = createUpgradesStore(SEED);
		store.getState().setPrune(true, SCOPE);
		const stored = store.getState().settings;
		expect(appliedSettings(stored, SCOPE)).toBe(stored);
	});

	it('applies nothing for a page whose spec has no ranking data', () => {
		const raw = createUpgradesStore(SEED).getState().settings;
		expect(appliedSettings(raw, undefined)).toBe(raw);
	});
});

describe('the user’s settings actions', () => {
	it('applies the defaults and then the toggle in one notification', () => {
		const store = createUpgradesStore(SEED);
		const listener = vi.fn();
		store.subscribe(listener);

		store.getState().toggleSet('saved:Tier 5', SCOPE);
		expect(listener).toHaveBeenCalledOnce();
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: ['preset:P3', 'saved:Tier 5'], defaultsFor: 'ret:3' });
	});

	it('keeps a set the user deselected deselected on the next write in the same scope', () => {
		const store = createUpgradesStore(SEED);
		store.getState().toggleSet('preset:P3', SCOPE);
		store.getState().setIterations(2000, SCOPE);
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: [], iterations: 2000 });
	});

	it('stores the scope’s defaults on the first write even when the value already holds', () => {
		const store = createUpgradesStore(SEED);
		const listener = vi.fn();
		store.subscribe(listener);

		store.getState().setPrune(false, SCOPE);
		expect(listener).toHaveBeenCalledOnce();
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: ['preset:P3'], prune: false, defaultsFor: 'ret:3' });
	});

	it('notifies nobody when a setting is set to the value it already holds', () => {
		const store = createUpgradesStore(SEED);
		store.getState().setPrune(false, SCOPE);
		const listener = vi.fn();
		store.subscribe(listener);

		store.getState().setPrune(false, SCOPE);
		store.getState().setIterations(1000, SCOPE);
		store.getState().setCandidateCap(undefined, SCOPE);
		expect(listener).not.toHaveBeenCalled();
	});

	it('notifies nobody on a second scope change, which has nothing left to forget', () => {
		const store = createUpgradesStore(SEED);
		store.getState().setPrune(true, SCOPE);
		store.getState().changeScope(['raid:hyjal']);
		const listener = vi.fn();
		store.subscribe(listener);

		store.getState().changeScope(['raid:hyjal']);
		expect(listener).not.toHaveBeenCalled();
	});
});

describe('run selectors', () => {
	it('gives no settled signature while a run is in flight, and the signature once it is done or stopped', () => {
		const store = createUpgradesStore(SEED);
		store.getState().startRun(1, 1000, MEASURED);
		expect(selectSettledSignature(store.getState())).toBeUndefined();

		store.getState().settleRun(1, RANKING_FIXTURE);
		expect(selectSettledSignature(store.getState())).toBe('sig-at-click');

		store.getState().startRun(2, 2000, MEASURED);
		const partial: PartialRanking & { durationMs: number } = { ...RANKING_FIXTURE, items: [rowA!], complete: false, durationMs: 9 };
		store.getState().settleRun(2, partial);
		expect(selectSettledSignature(store.getState())).toBe('sig-at-click');
	});
});

describe('setSort', () => {
	it('starts with no sort, the engine order', () => {
		expect(selectSort(createUpgradesStore(SEED).getState())).toEqual([]);
	});

	it('stores the sort it is given', () => {
		const store = createUpgradesStore(SEED);
		store.getState().setSort([{ id: 'item', desc: true }]);
		store.getState().setSort([{ id: 'item', desc: false }]);
		expect(selectSort(store.getState())).toEqual([{ id: 'item', desc: false }]);
	});

	it('tells every reader of the store, so a second table follows the first', () => {
		const store = createUpgradesStore(SEED);
		const first = vi.fn();
		const second = vi.fn();
		store.subscribe(selectSort, first);
		store.subscribe(selectSort, second);
		store.getState().setSort([{ id: 'delta_dps', desc: true }]);
		expect(first).toHaveBeenCalledWith([{ id: 'delta_dps', desc: true }], []);
		expect(second).toHaveBeenCalledWith([{ id: 'delta_dps', desc: true }], []);
	});

	it('notifies nobody when given the sort it already holds', () => {
		const store = createUpgradesStore(SEED);
		const listener = vi.fn();
		store.subscribe(listener);
		store.getState().setSort(selectSort(store.getState()));
		expect(listener).not.toHaveBeenCalled();
	});
});

describe('the source filter actions', () => {
	it('start with every source shown, or the hidden sources restored', () => {
		expect(selectHiddenSources(createUpgradesStore(SEED).getState())).toEqual([]);
		expect(selectHiddenSources(createUpgradesStore(SEED, { hiddenSources: ['Karazhan'] }).getState())).toEqual(['Karazhan']);
	});

	it('hide and show one source at a time, and set the whole list at once', () => {
		const store = createUpgradesStore(SEED);
		store.getState().toggleViewSource('Black Temple');
		store.getState().toggleViewSource('Karazhan');
		store.getState().toggleViewSource('Black Temple');
		expect(selectHiddenSources(store.getState())).toEqual(['Karazhan']);

		store.getState().setViewSources(['Crafted', 'PvP vendor']);
		expect(selectHiddenSources(store.getState())).toEqual(['Crafted', 'PvP vendor']);
		store.getState().setViewSources([]);
		expect(selectHiddenSources(store.getState())).toEqual([]);
	});

	it('notify nobody when the list is set to the sources it already hides', () => {
		const store = createUpgradesStore(SEED, { hiddenSources: ['Karazhan'] });
		const listener = vi.fn();
		store.subscribe(listener);
		store.getState().setViewSources(['Karazhan']);
		expect(listener).not.toHaveBeenCalled();
	});

	it('leave the run alone, so hiding a source never marks a result stale', () => {
		const store = createUpgradesStore(SEED);
		store.getState().startRun(1, 1000, MEASURED);
		store.getState().settleRun(1, RANKING_FIXTURE);
		const run = store.getState().run;
		store.getState().toggleViewSource('Black Temple');
		expect(store.getState().run).toBe(run);
		expect(selectSettledSignature(store.getState())).toBe('sig-at-click');
	});
});
