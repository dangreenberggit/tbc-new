import { describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { PartialRanking } from './engine/rank';
import {
	appliedSettings,
	createUpgradesStore,
	dispatchRun,
	dispatchSettings,
	selectRunStatus,
	selectSettledSignature,
	settingsActionIn,
} from './upgrades_store';

const [rowA] = RANKING_FIXTURE.items;
const SEED = { iterations: 1000, candidateCap: 40 };
const SCOPE = 'ret:3';
const DEFAULTS = { selectedSetKeys: ['preset:P3'], validSourceKeys: ['raid:hyjal'] };
const MEASURED = { inputsSignature: 'sig-at-click' };

describe('createUpgradesStore', () => {
	it('starts idle with the seed as the settings', () => {
		const store = createUpgradesStore(SEED);
		expect(selectRunStatus(store.getState())).toBe('idle');
		expect(store.getState().settings).toEqual({ excludedSources: [], selectedSetKeys: [], prune: false, iterations: 1000, candidateCap: 40 });
	});
});

describe('dispatchRun', () => {
	it('notifies nobody when a superseded run lands a row', () => {
		const store = createUpgradesStore(SEED);
		dispatchRun(store, { type: 'started', runId: 2, startedAt: 1000 });
		const listener = vi.fn();
		store.subscribe(listener);

		dispatchRun(store, { type: 'landed', runId: 1, row: rowA! });
		expect(listener).not.toHaveBeenCalled();

		dispatchRun(store, { type: 'landed', runId: 2, row: rowA! });
		expect(listener).toHaveBeenCalledOnce();
		expect(store.getState().run).toMatchObject({ status: 'running', landedRows: [rowA] });
	});

	it('leaves the settings object alone', () => {
		const store = createUpgradesStore(SEED);
		const settings = store.getState().settings;
		dispatchRun(store, { type: 'started', runId: 1, startedAt: 1000 });
		expect(store.getState().settings).toBe(settings);
	});
});

describe('appliedSettings', () => {
	it('applies the scope defaults to a fresh state and returns the same object on a second call', () => {
		const store = createUpgradesStore(SEED);
		const raw = store.getState().settings;
		const first = appliedSettings(raw, SCOPE, DEFAULTS);
		expect(first).toMatchObject({ selectedSetKeys: ['preset:P3'], defaultsFor: SCOPE });
		expect(raw.defaultsFor).toBeUndefined();
		expect(appliedSettings(first, SCOPE, DEFAULTS)).toBe(first);
	});

	it('returns the stored object once a write has stored the defaults', () => {
		const store = createUpgradesStore(SEED);
		settingsActionIn(store, SCOPE, DEFAULTS, { type: 'setPrune', prune: true });
		const stored = store.getState().settings;
		expect(appliedSettings(stored, SCOPE, DEFAULTS)).toBe(stored);
	});

	it('applies nothing for a page whose spec has no ranking data', () => {
		const raw = createUpgradesStore(SEED).getState().settings;
		expect(appliedSettings(raw, undefined, DEFAULTS)).toBe(raw);
	});
});

describe('settingsActionIn', () => {
	it('applies the defaults and then the toggle in one notification', () => {
		const store = createUpgradesStore(SEED);
		const listener = vi.fn();
		store.subscribe(listener);

		settingsActionIn(store, SCOPE, DEFAULTS, { type: 'toggleSet', key: 'saved:Tier 5' });
		expect(listener).toHaveBeenCalledOnce();
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: ['preset:P3', 'saved:Tier 5'], defaultsFor: SCOPE });
	});

	it('keeps a set the user deselected deselected on the next write in the same scope', () => {
		const store = createUpgradesStore(SEED);
		settingsActionIn(store, SCOPE, DEFAULTS, { type: 'toggleSet', key: 'preset:P3' });
		settingsActionIn(store, SCOPE, DEFAULTS, { type: 'setIterations', iterations: 2000 });
		expect(store.getState().settings).toMatchObject({ selectedSetKeys: [], iterations: 2000 });
	});

	it('notifies nobody when the write changes nothing', () => {
		const store = createUpgradesStore(SEED);
		settingsActionIn(store, SCOPE, DEFAULTS, { type: 'setPrune', prune: false });
		const listener = vi.fn();
		store.subscribe(listener);
		dispatchSettings(store, { type: 'applyDefaults', key: SCOPE, ...DEFAULTS });
		expect(listener).not.toHaveBeenCalled();
	});
});

describe('run selectors', () => {
	it('gives no settled signature while a run is in flight, and the signature once it is done or stopped', () => {
		const store = createUpgradesStore(SEED);
		dispatchRun(store, { type: 'started', runId: 1, startedAt: 1000, measuredOn: MEASURED });
		expect(selectSettledSignature(store.getState())).toBeUndefined();

		dispatchRun(store, { type: 'finished', runId: 1, result: RANKING_FIXTURE });
		expect(selectSettledSignature(store.getState())).toBe('sig-at-click');

		dispatchRun(store, { type: 'started', runId: 2, startedAt: 2000, measuredOn: MEASURED });
		const partial: PartialRanking & { durationMs: number } = { ...RANKING_FIXTURE, items: [rowA!], complete: false, durationMs: 9 };
		dispatchRun(store, { type: 'stopped', runId: 2, result: partial });
		expect(selectSettledSignature(store.getState())).toBe('sig-at-click');
	});
});
