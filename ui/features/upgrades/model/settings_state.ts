/**
 * The tab's run settings (excluded sources, selected sets, prune, candidate cap,
 * iterations) and the pure functions the store's actions change them with. One
 * state, because the eligible count and the run read several of them together.
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

/** Passed as undefined for a spec with no ranking data, which has no defaults. */
export type SettingsScope = { specPhase: string; defaultSetKeys: readonly string[]; poolSourceKeys: readonly string[] };

/** A cap of 0 means "no cap". */
const normaliseCap = (cap: number | undefined): number | undefined => (cap !== undefined && cap > 0 ? cap : undefined);

const toggled = (keys: readonly string[], key: string): readonly string[] => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]);

/** The exclusions a pool offering `poolSourceKeys` still offers; an exclusion it does not offer would narrow it invisibly. */
const offeredExclusions = (excluded: readonly string[], poolSourceKeys: readonly string[]): readonly string[] => {
	const valid = new Set(poolSourceKeys);
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

export const withPrune = (state: SettingsState, prune: boolean): SettingsState => (state.prune === prune ? state : { ...state, prune });

export function withCandidateCap(state: SettingsState, cap: number | undefined): SettingsState {
	const candidateCap = normaliseCap(cap);
	return state.candidateCap === candidateCap ? state : { ...state, candidateCap };
}

export const withIterations = (state: SettingsState, iterations: number): SettingsState => (state.iterations === iterations ? state : { ...state, iterations });

/**
 * The settings the tab shows and runs with: the stored state with the default sets for `scope` applied. Pure, so
 * render can compute it; the settings actions apply it before the user's change, so the stored state matches what
 * was shown. Returns the given state once the defaults are stored, or when there is no `scope`.
 */
export function appliedSettings(state: SettingsState, scope: SettingsScope | undefined): SettingsState {
	// Once per spec:phase, so a set the user deselects stays deselected through the re-renders a gear change causes.
	if (!scope || state.defaultsFor === scope.specPhase) return state;
	return {
		...state,
		selectedSetKeys: scope.defaultSetKeys,
		excludedSources: offeredExclusions(state.excludedSources, scope.poolSourceKeys),
		defaultsFor: scope.specPhase,
	};
}

/**
 * The page moved to another spec:phase, which gets its own default sets when next applied. An exclusion the new pool
 * does not offer is dropped now, so it stays dropped on the way back. With nothing to forget or drop, returns `state`.
 */
export function afterScopeChange(state: SettingsState, poolSourceKeys: readonly string[]): SettingsState {
	const excludedSources = offeredExclusions(state.excludedSources, poolSourceKeys);
	const unchanged = state.selectedSetKeys.length === 0 && state.defaultsFor === undefined && excludedSources.length === state.excludedSources.length;
	return unchanged ? state : { ...state, selectedSetKeys: [], excludedSources, defaultsFor: undefined };
}

/** A saved exclusion that a data update removed from the pool excludes nothing, but the Sources summary would count it. */
export function withoutUnofferedSources(state: SettingsState, poolSourceKeys: readonly string[]): SettingsState {
	const kept = offeredExclusions(state.excludedSources, poolSourceKeys);
	return kept.length === state.excludedSources.length ? state : { ...state, excludedSources: kept };
}

/** The prune box is hidden while no set is selected, and a hidden box reads as off. */
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
