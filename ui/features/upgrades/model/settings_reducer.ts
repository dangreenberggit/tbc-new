/**
 * The Upgrades tab's run settings: which sources are excluded, which sets are
 * selected, the prune, the candidate cap and the iteration count. One reducer,
 * because the eligible count and the run read several of them together. Pure;
 * the hook that owns it derives the options from the page.
 */

import { type RunSettings, runSettings } from './run_reducer';

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

export type SettingsAction =
	| { type: 'toggleSource'; key: string }
	| { type: 'toggleSet'; key: string }
	| { type: 'setPrune'; prune: boolean }
	| { type: 'setCandidateCap'; cap: number | undefined }
	| { type: 'setIterations'; iterations: number }
	| { type: 'applyDefaults'; key: string; selectedSetKeys: readonly string[]; validSourceKeys: readonly string[] };

/** The old tab's cap field read 0 as "no cap" (C6). */
const normaliseCap = (cap: number | undefined): number | undefined => (cap !== undefined && cap > 0 ? cap : undefined);

const toggled = (keys: readonly string[], key: string): readonly string[] => (keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]);

export const initialSettings = (seed: { iterations: number; candidateCap?: number }): SettingsState => ({
	excludedSources: [],
	selectedSetKeys: [],
	prune: false,
	candidateCap: normaliseCap(seed.candidateCap),
	iterations: seed.iterations,
});

export function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
	switch (action.type) {
		case 'toggleSource':
			return { ...state, excludedSources: toggled(state.excludedSources, action.key) };
		case 'toggleSet':
			return { ...state, selectedSetKeys: toggled(state.selectedSetKeys, action.key) };
		case 'setPrune':
			return { ...state, prune: action.prune };
		case 'setCandidateCap':
			return { ...state, candidateCap: normaliseCap(action.cap) };
		case 'setIterations':
			return { ...state, iterations: action.iterations };
		case 'applyDefaults': {
			// Once per spec:phase, so a set the user deselects stays deselected
			// through the re-renders a gear change causes.
			if (state.defaultsFor === action.key) return state;
			// An exclusion the new pool does not offer would narrow it invisibly.
			const valid = new Set(action.validSourceKeys);
			return {
				...state,
				selectedSetKeys: action.selectedSetKeys,
				excludedSources: state.excludedSources.filter(key => valid.has(key)),
				defaultsFor: action.key,
			};
		}
	}
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
