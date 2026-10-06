import { describe, expect, it } from 'vitest';

import { initialSettings, pruneEffective, type SettingsAction, settingsReducer, type SettingsState, toRunSettings } from './settings_reducer';

const seeded = (): SettingsState => initialSettings({ iterations: 3000 });
const apply = (state: SettingsState, ...actions: SettingsAction[]) => actions.reduce(settingsReducer, state);

describe('initialSettings', () => {
	it('starts with nothing excluded, no set selected, prune off and the seeded iterations and cap', () => {
		expect(initialSettings({ iterations: 500, candidateCap: 10 })).toEqual({
			excludedSources: [],
			selectedSetKeys: [],
			prune: false,
			candidateCap: 10,
			iterations: 500,
			otherSetsOpen: false,
		});
	});

	it('treats a seeded cap of 0 as no cap', () => {
		expect(initialSettings({ iterations: 500, candidateCap: 0 }).candidateCap).toBeUndefined();
	});
});

describe('settingsReducer', () => {
	it('excludes a source on the first toggle and includes it again on the second', () => {
		const once = apply(seeded(), { type: 'toggleSource', key: 'Black Temple' });
		expect(once.excludedSources).toEqual(['Black Temple']);
		expect(apply(once, { type: 'toggleSource', key: 'Black Temple' }).excludedSources).toEqual([]);
	});

	it('selects and deselects a set', () => {
		const once = apply(seeded(), { type: 'toggleSet', key: 'preset:3:P3' });
		expect(once.selectedSetKeys).toEqual(['preset:3:P3']);
		expect(apply(once, { type: 'toggleSet', key: 'preset:3:P3' }).selectedSetKeys).toEqual([]);
	});

	it('sets prune', () => {
		expect(apply(seeded(), { type: 'setPrune', prune: true }).prune).toBe(true);
	});

	it('keeps a positive cap and reads 0 or less as no cap', () => {
		expect(apply(seeded(), { type: 'setCandidateCap', cap: 40 }).candidateCap).toBe(40);
		expect(apply(seeded(), { type: 'setCandidateCap', cap: 40 }, { type: 'setCandidateCap', cap: 0 }).candidateCap).toBeUndefined();
		expect(apply(seeded(), { type: 'setCandidateCap', cap: -3 }).candidateCap).toBeUndefined();
		expect(apply(seeded(), { type: 'setCandidateCap', cap: undefined }).candidateCap).toBeUndefined();
	});

	it('sets iterations', () => {
		expect(apply(seeded(), { type: 'setIterations', iterations: 2000 }).iterations).toBe(2000);
	});

	it('opens and closes the other-sets disclosure', () => {
		const open = apply(seeded(), { type: 'toggleOtherSets' });
		expect(open.otherSetsOpen).toBe(true);
		expect(apply(open, { type: 'toggleOtherSets' }).otherSetsOpen).toBe(false);
	});

	it('applies the default sets once per spec and phase, so a later deselect survives', () => {
		const defaults = { type: 'applyDefaults', key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] } as const;
		const first = apply(seeded(), defaults);
		expect(first).toMatchObject({ selectedSetKeys: ['preset:3:P3'], defaultsFor: 'ret:3' });

		const deselected = apply(first, { type: 'toggleSet', key: 'preset:3:P3' });
		const again = apply(deselected, defaults);
		expect(again).toBe(deselected);
	});

	it('re-applies the defaults when the spec or phase changes', () => {
		const p3 = apply(seeded(), { type: 'applyDefaults', key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] });
		const p4 = apply(p3, { type: 'applyDefaults', key: 'ret:4', selectedSetKeys: [], validSourceKeys: [] });
		expect(p4).toMatchObject({ selectedSetKeys: [], defaultsFor: 'ret:4' });
	});

	it('drops an exclusion whose source the new pool no longer offers', () => {
		const excluded = apply(seeded(), { type: 'toggleSource', key: 'Black Temple' }, { type: 'toggleSource', key: 'Crafted' });
		const next = apply(excluded, { type: 'applyDefaults', key: 'ret:2', selectedSetKeys: [], validSourceKeys: ['Crafted', 'Badge vendor'] });
		expect(next.excludedSources).toEqual(['Crafted']);
	});
});

describe('pruneEffective', () => {
	it('is on only while prune is ticked and a set is selected', () => {
		expect(pruneEffective(apply(seeded(), { type: 'setPrune', prune: true }))).toBe(false);
		expect(pruneEffective(apply(seeded(), { type: 'toggleSet', key: 'preset:3:P3' }))).toBe(false);
		expect(pruneEffective(apply(seeded(), { type: 'toggleSet', key: 'preset:3:P3' }, { type: 'setPrune', prune: true }))).toBe(true);
	});
});

describe('toRunSettings', () => {
	it('carries every setting the run reads', () => {
		const state = apply(
			initialSettings({ iterations: 500, candidateCap: 10 }),
			{ type: 'toggleSource', key: 'Crafted' },
			{ type: 'toggleSet', key: 'preset:3:P3' },
			{ type: 'setPrune', prune: true },
		);
		expect(toRunSettings(state, [30129, 32461])).toEqual({
			iterations: 500,
			candidateCap: 10,
			excludedSources: ['Crafted'],
			guaranteedSetKeys: ['preset:3:P3'],
			guaranteedSetItemIds: [30129, 32461],
			prune: true,
		});
	});

	it('runs the default iteration count when the field is empty or zero', () => {
		expect(toRunSettings(apply(seeded(), { type: 'setIterations', iterations: 0 }), []).iterations).toBe(3000);
	});

	it('never prunes to an empty pool when the selected sets hold no items', () => {
		const state = apply(seeded(), { type: 'toggleSet', key: 'saved:empty' }, { type: 'setPrune', prune: true });
		expect(toRunSettings(state, []).prune).toBe(false);
	});
});
