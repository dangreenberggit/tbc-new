import { describe, expect, it } from 'vitest';

import {
	afterScopeChange,
	appliedSettings,
	initialSettings,
	pruneEffective,
	type SettingsState,
	toRunSettings,
	withCandidateCap,
	withExcludedSourceToggled,
	withGearSetToggled,
	withIterations,
	withPrune,
} from './settings_state';

const fresh = (): SettingsState => initialSettings({ iterations: 3000 });

describe('initialSettings', () => {
	it('starts with nothing excluded, no set selected, prune off, no cap and the initial iterations', () => {
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
		const once = withExcludedSourceToggled(fresh(), 'Black Temple');
		expect(once.excludedSources).toEqual(['Black Temple']);
		expect(withExcludedSourceToggled(once, 'Black Temple').excludedSources).toEqual([]);
	});

	it('selects and deselects a set', () => {
		const once = withGearSetToggled(fresh(), 'preset:3:P3');
		expect(once.selectedSetKeys).toEqual(['preset:3:P3']);
		expect(withGearSetToggled(once, 'preset:3:P3').selectedSetKeys).toEqual([]);
	});

	it('sets prune', () => {
		expect(withPrune(fresh(), true).prune).toBe(true);
	});

	it('keeps a positive cap and reads 0 or less as no cap', () => {
		expect(withCandidateCap(fresh(), 40).candidateCap).toBe(40);
		expect(withCandidateCap(withCandidateCap(fresh(), 40), 0).candidateCap).toBeUndefined();
		expect(withCandidateCap(fresh(), -3).candidateCap).toBeUndefined();
		expect(withCandidateCap(fresh(), undefined).candidateCap).toBeUndefined();
	});

	it('sets iterations', () => {
		expect(withIterations(fresh(), 2000).iterations).toBe(2000);
	});

	// The store writes nothing for a change that returns the state it was given, so the page saves nothing either.
	it('returns the state it was given when prune, the cap or the iterations already hold the value', () => {
		const capped = withCandidateCap(fresh(), 40);
		expect(withPrune(capped, false)).toBe(capped);
		expect(withCandidateCap(capped, 40)).toBe(capped);
		expect(withIterations(capped, 3000)).toBe(capped);

		const uncapped = fresh();
		expect(withCandidateCap(uncapped, 0)).toBe(uncapped);
	});

	it('applies the default sets once per spec and phase, so a later deselect survives', () => {
		const scope = { specPhase: 'ret:3', defaultGearSetKeys: ['preset:3:P3'], poolSourceKeys: [] };
		const first = appliedSettings(fresh(), scope);
		expect(first).toMatchObject({ selectedSetKeys: ['preset:3:P3'], defaultsFor: 'ret:3' });

		const deselected = withGearSetToggled(first, 'preset:3:P3');
		const again = appliedSettings(deselected, scope);
		expect(again).toBe(deselected);
	});

	it('re-applies the defaults when the spec or phase changes', () => {
		const p3 = appliedSettings(fresh(), { specPhase: 'ret:3', defaultGearSetKeys: ['preset:3:P3'], poolSourceKeys: [] });
		const p4 = appliedSettings(p3, { specPhase: 'ret:4', defaultGearSetKeys: [], poolSourceKeys: [] });
		expect(p4).toMatchObject({ selectedSetKeys: [], defaultsFor: 'ret:4' });
	});

	it('drops an exclusion whose source the new pool no longer offers', () => {
		const excluded = withExcludedSourceToggled(withExcludedSourceToggled(fresh(), 'Black Temple'), 'Crafted');
		const next = appliedSettings(excluded, { specPhase: 'ret:2', defaultGearSetKeys: [], poolSourceKeys: ['Crafted', 'Badge vendor'] });
		expect(next.excludedSources).toEqual(['Crafted']);
	});

	it('forgets the applied defaults and the picked sets when the scope changes, so the new scope’s defaults apply even after a deselect', () => {
		const scope = { specPhase: 'ret:3', defaultGearSetKeys: ['preset:3:P3'], poolSourceKeys: [] };
		const deselected = withGearSetToggled(appliedSettings(fresh(), scope), 'preset:3:P3');
		const changed = afterScopeChange(deselected, []);
		expect(changed).toMatchObject({ selectedSetKeys: [], defaultsFor: undefined });

		const back = appliedSettings(changed, scope);
		expect(back).toMatchObject({ selectedSetKeys: ['preset:3:P3'], defaultsFor: 'ret:3' });
	});

	it('drops on a scope change only the exclusions the new pool does not offer, and keeps the other settings', () => {
		const excluded = withExcludedSourceToggled(withExcludedSourceToggled(fresh(), 'Hyjal Summit'), 'Black Temple');
		const edited = withIterations(withPrune(excluded, true), 2000);
		const changed = afterScopeChange(edited, ['Black Temple', 'Zul’Aman']);
		expect(changed).toMatchObject({ excludedSources: ['Black Temple'], prune: true, iterations: 2000 });
	});

	it('forgets the picked sets on a scope change even when no defaults were applied', () => {
		const picked = withGearSetToggled(fresh(), 'preset:3:P3');
		expect(picked.defaultsFor).toBeUndefined();
		expect(afterScopeChange(picked, [])).toMatchObject({ selectedSetKeys: [], defaultsFor: undefined });
	});

	it('returns the state it was given on a scope change with no sets to forget and no exclusion to drop', () => {
		const changed = afterScopeChange(withExcludedSourceToggled(fresh(), 'Black Temple'), ['Black Temple']);
		expect(afterScopeChange(changed, ['Black Temple'])).toBe(changed);
	});
});

describe('pruneEffective', () => {
	it('is on only while prune is ticked and a set is selected', () => {
		expect(pruneEffective(withPrune(fresh(), true))).toBe(false);
		expect(pruneEffective(withGearSetToggled(fresh(), 'preset:3:P3'))).toBe(false);
		expect(pruneEffective(withPrune(withGearSetToggled(fresh(), 'preset:3:P3'), true))).toBe(true);
	});
});

describe('toRunSettings', () => {
	it('carries every setting the run reads', () => {
		const capped = withCandidateCap(initialSettings({ iterations: 500 }), 10);
		const state = withPrune(withGearSetToggled(withExcludedSourceToggled(capped, 'Crafted'), 'preset:3:P3'), true);
		expect(toRunSettings(state, [30129, 32461])).toEqual({
			iterations: 500,
			candidateCap: 10,
			excludedSources: ['Crafted'],
			selectedGearSetKeys: ['preset:3:P3'],
			selectedGearSetItemIds: [30129, 32461],
			prune: true,
		});
	});

	it('runs the default iteration count when the field is empty or zero', () => {
		expect(toRunSettings(withIterations(fresh(), 0), []).iterations).toBe(3000);
	});

	it('never prunes to an empty pool when the selected sets hold no items', () => {
		const state = withPrune(withGearSetToggled(fresh(), 'saved:empty'), true);
		expect(toRunSettings(state, []).prune).toBe(false);
	});
});
