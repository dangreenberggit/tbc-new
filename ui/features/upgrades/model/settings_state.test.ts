import { describe, expect, it } from 'vitest';

import {
	afterScopeChange,
	appliedSettings,
	initialSettings,
	pruneEffective,
	type SettingsState,
	toRunSettings,
	withCandidateCap,
	withIterations,
	withPrune,
	withSetToggled,
	withSourceToggled,
} from './settings_state';

const seeded = (): SettingsState => initialSettings({ iterations: 3000 });

describe('initialSettings', () => {
	it('starts with nothing excluded, no set selected, prune off, no cap and the seeded iterations', () => {
		expect(initialSettings({ iterations: 500 })).toEqual({
			excludedSources: [],
			selectedSetKeys: [],
			prune: false,
			candidateCap: undefined,
			iterations: 500,
		});
	});
});

describe('the settings changes', () => {
	it('excludes a source on the first toggle and includes it again on the second', () => {
		const once = withSourceToggled(seeded(), 'Black Temple');
		expect(once.excludedSources).toEqual(['Black Temple']);
		expect(withSourceToggled(once, 'Black Temple').excludedSources).toEqual([]);
	});

	it('selects and deselects a set', () => {
		const once = withSetToggled(seeded(), 'preset:3:P3');
		expect(once.selectedSetKeys).toEqual(['preset:3:P3']);
		expect(withSetToggled(once, 'preset:3:P3').selectedSetKeys).toEqual([]);
	});

	it('sets prune', () => {
		expect(withPrune(seeded(), true).prune).toBe(true);
	});

	it('keeps a positive cap and reads 0 or less as no cap', () => {
		expect(withCandidateCap(seeded(), 40).candidateCap).toBe(40);
		expect(withCandidateCap(withCandidateCap(seeded(), 40), 0).candidateCap).toBeUndefined();
		expect(withCandidateCap(seeded(), -3).candidateCap).toBeUndefined();
		expect(withCandidateCap(seeded(), undefined).candidateCap).toBeUndefined();
	});

	it('sets iterations', () => {
		expect(withIterations(seeded(), 2000).iterations).toBe(2000);
	});

	// The store writes nothing for a change that returns the state it was given, so the page saves nothing either.
	it('returns the state it was given when prune, the cap or the iterations already hold the value', () => {
		const capped = withCandidateCap(seeded(), 40);
		expect(withPrune(capped, false)).toBe(capped);
		expect(withCandidateCap(capped, 40)).toBe(capped);
		expect(withIterations(capped, 3000)).toBe(capped);

		const uncapped = seeded();
		expect(withCandidateCap(uncapped, 0)).toBe(uncapped);
	});

	it('applies the default sets once per spec and phase, so a later deselect survives', () => {
		const scope = { key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] };
		const first = appliedSettings(seeded(), scope);
		expect(first).toMatchObject({ selectedSetKeys: ['preset:3:P3'], defaultsFor: 'ret:3' });

		const deselected = withSetToggled(first, 'preset:3:P3');
		const again = appliedSettings(deselected, scope);
		expect(again).toBe(deselected);
	});

	it('re-applies the defaults when the spec or phase changes', () => {
		const p3 = appliedSettings(seeded(), { key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] });
		const p4 = appliedSettings(p3, { key: 'ret:4', selectedSetKeys: [], validSourceKeys: [] });
		expect(p4).toMatchObject({ selectedSetKeys: [], defaultsFor: 'ret:4' });
	});

	it('drops an exclusion whose source the new pool no longer offers', () => {
		const excluded = withSourceToggled(withSourceToggled(seeded(), 'Black Temple'), 'Crafted');
		const next = appliedSettings(excluded, { key: 'ret:2', selectedSetKeys: [], validSourceKeys: ['Crafted', 'Badge vendor'] });
		expect(next.excludedSources).toEqual(['Crafted']);
	});

	it('forgets the applied defaults and the picked sets when the scope changes, so the new scope’s defaults apply even after a deselect', () => {
		const scope = { key: 'ret:3', selectedSetKeys: ['preset:3:P3'], validSourceKeys: [] };
		const deselected = withSetToggled(appliedSettings(seeded(), scope), 'preset:3:P3');
		const changed = afterScopeChange(deselected, []);
		expect(changed).toMatchObject({ selectedSetKeys: [], defaultsFor: undefined });

		const back = appliedSettings(changed, scope);
		expect(back).toMatchObject({ selectedSetKeys: ['preset:3:P3'], defaultsFor: 'ret:3' });
	});

	it('drops on a scope change only the exclusions the new pool does not offer, and keeps the other settings', () => {
		const excluded = withSourceToggled(withSourceToggled(seeded(), 'Hyjal Summit'), 'Black Temple');
		const edited = withIterations(withPrune(excluded, true), 2000);
		const changed = afterScopeChange(edited, ['Black Temple', 'Zul’Aman']);
		expect(changed).toMatchObject({ excludedSources: ['Black Temple'], prune: true, iterations: 2000 });
	});

	it('returns the state it was given on a scope change with no sets to forget and no exclusion to drop', () => {
		const changed = afterScopeChange(withSourceToggled(seeded(), 'Black Temple'), ['Black Temple']);
		expect(afterScopeChange(changed, ['Black Temple'])).toBe(changed);
	});
});

describe('pruneEffective', () => {
	it('is on only while prune is ticked and a set is selected', () => {
		expect(pruneEffective(withPrune(seeded(), true))).toBe(false);
		expect(pruneEffective(withSetToggled(seeded(), 'preset:3:P3'))).toBe(false);
		expect(pruneEffective(withPrune(withSetToggled(seeded(), 'preset:3:P3'), true))).toBe(true);
	});
});

describe('toRunSettings', () => {
	it('carries every setting the run reads', () => {
		const capped = withCandidateCap(initialSettings({ iterations: 500 }), 10);
		const state = withPrune(withSetToggled(withSourceToggled(capped, 'Crafted'), 'preset:3:P3'), true);
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
		expect(toRunSettings(withIterations(seeded(), 0), []).iterations).toBe(3000);
	});

	it('never prunes to an empty pool when the selected sets hold no items', () => {
		const state = withPrune(withSetToggled(seeded(), 'saved:empty'), true);
		expect(toRunSettings(state, []).prune).toBe(false);
	});
});
