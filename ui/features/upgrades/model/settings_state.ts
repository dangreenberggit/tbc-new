/**
 * The Upgrades tab's run settings: which sources are excluded, which sets are
 * selected, the prune, the candidate cap and the iteration count, and the pure
 * functions that change them. One state, because the eligible count and the
 * run read several of them together. The tab's store actions call these
 * functions (`upgrades_store.ts`), and `useUpgradesSettings` derives the
 * options from the page.
 */

import { type RunSettings, runSettings } from './run_state';

export type SettingsState = {
	excludedSources: readonly string[];
	selectedSetKeys: readonly string[];
	prune: boolean;
	/** Undefined is no cap. */
	candidateCap?: number;
	iterations: number;
	/** The `spec:phase` the default sets were last applied for. */
	defaultsFor?: string;
};

/**
 * The `spec:phase` the tab is on, with the sets it selects before the user picks any and the sources its pool
 * offers. Undefined where it is taken means a spec with no ranking data, which has no defaults.
 */
export type SettingsScope = { key: string; selectedSetKeys: readonly string[]; validSourceKeys: readonly string[] };

/** The old tab's cap field read 0 as "no cap" (C6). */
const normaliseCap = (cap: number | undefined): number | undefined => (cap !== undefined && cap > 0 ? cap : undefined);

const toggled = (keys: readonly string[], key: string): readonly string[] => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]);

/** The exclusions a pool offering `validSourceKeys` still offers; an exclusion it does not offer would narrow it invisibly. */
const offeredExclusions = (excluded: readonly string[], validSourceKeys: readonly string[]): readonly string[] => {
	const valid = new Set(validSourceKeys);
	return excluded.filter(key => valid.has(key));
};

/** No cap: only the dev link sets one (`utils/dev_flags.ts`), and it goes over these settings (`saved_settings.ts`). */
export const initialSettings = (seed: { iterations: number }): SettingsState => ({
	excludedSources: [],
	selectedSetKeys: [],
	prune: false,
	candidateCap: undefined,
	iterations: seed.iterations,
});

export const withSourceToggled = (state: SettingsState, key: string): SettingsState => ({ ...state, excludedSources: toggled(state.excludedSources, key) });

export const withSetToggled = (state: SettingsState, key: string): SettingsState => ({ ...state, selectedSetKeys: toggled(state.selectedSetKeys, key) });

// The three setters below return the state they were given when the value already holds, so the store writes nothing.
export const withPrune = (state: SettingsState, prune: boolean): SettingsState => (state.prune === prune ? state : { ...state, prune });

export function withCandidateCap(state: SettingsState, cap: number | undefined): SettingsState {
	const candidateCap = normaliseCap(cap);
	return state.candidateCap === candidateCap ? state : { ...state, candidateCap };
}

export const withIterations = (state: SettingsState, iterations: number): SettingsState => (state.iterations === iterations ? state : { ...state, iterations });

/**
 * The settings the tab shows and runs with: the stored state with the scope's default sets applied. Pure, so a
 * reader computes it during render without writing; the store's settings actions apply it before the user's change,
 * so the stored state matches what was shown. It returns the state it was given once the defaults are stored, or
 * when there is no scope.
 */
export function appliedSettings(state: SettingsState, scope: SettingsScope | undefined): SettingsState {
	// Once per spec:phase, so a set the user deselects stays deselected through the re-renders a gear change causes.
	if (!scope || state.defaultsFor === scope.key) return state;
	return {
		...state,
		selectedSetKeys: scope.selectedSetKeys,
		excludedSources: offeredExclusions(state.excludedSources, scope.validSourceKeys),
		defaultsFor: scope.key,
	};
}

/**
 * The page moved to another spec:phase, which gets its own default sets when next applied, as on the old tab
 * whatever the user had picked. An exclusion the new pool does not offer is dropped now, so it stays dropped on the
 * way back, as when the old tab applied that phase. With no sets to forget and no exclusion to drop, it returns the
 * state it was given.
 */
export function afterScopeChange(state: SettingsState, validSourceKeys: readonly string[]): SettingsState {
	const excludedSources = offeredExclusions(state.excludedSources, validSourceKeys);
	const unchanged = state.selectedSetKeys.length === 0 && state.defaultsFor === undefined && excludedSources.length === state.excludedSources.length;
	return unchanged ? state : { ...state, selectedSetKeys: [], excludedSources, defaultsFor: undefined };
}

/** A saved exclusion that a data update removed from the pool excludes nothing, but the Sources summary would count it. */
export function withoutUnofferedSources(state: SettingsState, validSourceKeys: readonly string[]): SettingsState {
	const kept = offeredExclusions(state.excludedSources, validSourceKeys);
	return kept.length === state.excludedSources.length ? state : { ...state, excludedSources: kept };
}

/** The old tab hid the prune box while no set was selected, and a hidden box read as off. */
export const pruneEffective = (state: SettingsState): boolean => state.prune && state.selectedSetKeys.length > 0;

export const toRunSettings = (state: SettingsState, selectedSetItemIds: readonly number[]): RunSettings => ({
	// The field can be empty or zero; the run then takes the default count.
	...runSettings(state.iterations, state.candidateCap),
	excludedSources: state.excludedSources,
	guaranteedSetKeys: state.selectedSetKeys,
	guaranteedSetItemIds: selectedSetItemIds,
	// Selected sets with no items would prune the pool to nothing.
	prune: pruneEffective(state) && selectedSetItemIds.length > 0,
});
