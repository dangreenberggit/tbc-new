/**
 * The Upgrades tab's state as a zustand store, one per page `Sim` (ticket
 * 564), built the way upstream's sim store is (`ui/sim/state/sim_store.ts`).
 * The two reducers stay the only code that builds a new state; the helpers
 * here call them and write the result.
 */

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import { IDLE_RUN, type RunAction, runReducer, type RunState } from './run_reducer';
import { initialSettings, type SettingsAction, settingsReducer, type SettingsState } from './settings_reducer';

export type UpgradesState = { run: RunState; settings: SettingsState };

/** The settings a new store starts with: the dev link's iterations and cap, or the defaults. */
export type SettingsSeed = { iterations: number; candidateCap?: number };

/** The sets a scope selects before the user picks any, and the sources its pool offers. */
export type SettingsDefaults = { selectedSetKeys: readonly string[]; validSourceKeys: readonly string[] };

export type UpgradesStore = ReturnType<typeof createUpgradesStore>;

export function createUpgradesStore(seed: SettingsSeed) {
	return createStore<UpgradesState>()(subscribeWithSelector(() => ({ run: IDLE_RUN, settings: initialSettings(seed) })));
}

/** A reducer that returns the state it was given writes nothing, so a superseded run's late row notifies nobody. */
export function dispatchRun(store: UpgradesStore, action: RunAction): void {
	const { run } = store.getState();
	const next = runReducer(run, action);
	if (next !== run) store.setState({ run: next });
}

export function dispatchSettings(store: UpgradesStore, action: SettingsAction): void {
	const { settings } = store.getState();
	const next = settingsReducer(settings, action);
	if (next !== settings) store.setState({ settings: next });
}

export const applyDefaultsAction = (scope: string, defaults: SettingsDefaults): SettingsAction => ({
	type: 'applyDefaults',
	key: scope,
	selectedSetKeys: defaults.selectedSetKeys,
	validSourceKeys: defaults.validSourceKeys,
});

/**
 * The settings the tab shows and runs with: the stored state with the scope's
 * default sets applied. A derivation, not a write, so a reader computes it
 * during render; once a write has stored the defaults it returns the stored
 * object. `scope` is undefined for a spec with no ranking data.
 */
export const appliedSettings = (state: SettingsState, scope: string | undefined, defaults: SettingsDefaults): SettingsState =>
	scope ? settingsReducer(state, applyDefaultsAction(scope, defaults)) : state;

/** A user's settings write: the scope's defaults first, so the stored state matches what was shown, then the action, in one notification. */
export function settingsActionIn(store: UpgradesStore, scope: string | undefined, defaults: SettingsDefaults, action: SettingsAction): void {
	const { settings } = store.getState();
	const next = settingsReducer(appliedSettings(settings, scope, defaults), action);
	if (next !== settings) store.setState({ settings: next });
}

export const selectRun = (state: UpgradesState): RunState => state.run;
export const selectRunStatus = (state: UpgradesState): RunState['status'] => state.run.status;

/** The signature the result on screen was measured on; none while a run is in flight, which is never stale (ticket 560). */
export const selectSettledSignature = (state: UpgradesState): string | undefined =>
	state.run.status === 'done' || state.run.status === 'stopped' ? state.run.measuredOn?.inputsSignature : undefined;
