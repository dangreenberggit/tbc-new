/**
 * The Upgrades tab's state as a zustand store, one per page `Sim` (ticket
 * 564), built the way upstream's sim store is (`ui/sim/state/sim_store.ts`).
 * The two reducers stay the only code that builds a new state; the helpers
 * here call them and write the result.
 */

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type { ExportFlavour } from './export';
import { NO_VIEW_TOGGLES, type ViewToggles } from './results_view';
import { IDLE_RUN, type RunAction, runReducer, type RunState } from './run_reducer';
import { initialSettings, type SettingsAction, settingsReducer, type SettingsState } from './settings_reducer';

/**
 * A column sort in TanStack Table's `SortingState` shape, declared here so the
 * model imports no React package; the table reads it as its controlled
 * `sorting` (ticket 565). Empty is the engine's order.
 */
export type ResultsSort = Array<{ id: string; desc: boolean }>;

/**
 * `sort` is the one column sort every results table and the export follow
 * (ticket 280). `view` is the view toggles as the user set them; a run that
 * does not offer one shows it off (`appliedToggles`). `exportFlavour` is the
 * export panel's token or gear choice. All three hold across runs, and the
 * page saves them with the settings (`saved_settings.ts`).
 */
export type UpgradesState = { run: RunState; settings: SettingsState; sort: ResultsSort; view: ViewToggles; exportFlavour: ExportFlavour };

/** The settings a new store starts from, before the page's saved entry and the dev link go over them (`saved_settings.ts`). */
export type SettingsSeed = { iterations: number; candidateCap?: number };

/** What a store restores from storage over its seed: only the fields that read back valid. */
export type RestoredTab = { settings?: Partial<SettingsState>; sort?: ResultsSort; view?: Partial<ViewToggles>; exportFlavour?: ExportFlavour };

/** The sets a scope selects before the user picks any, and the sources its pool offers. */
export type SettingsDefaults = { selectedSetKeys: readonly string[]; validSourceKeys: readonly string[] };

export type UpgradesStore = ReturnType<typeof createUpgradesStore>;

export function createUpgradesStore(seed: SettingsSeed, restored: RestoredTab = {}) {
	return createStore<UpgradesState>()(
		subscribeWithSelector((): UpgradesState => ({
			run: IDLE_RUN,
			settings: { ...initialSettings(seed), ...restored.settings },
			sort: restored.sort ?? [],
			view: { ...NO_VIEW_TOGGLES, ...restored.view },
			// The token is the default: the raid awards the token, not the tier piece (`ExportPanel`).
			exportFlavour: restored.exportFlavour ?? 'token',
		})),
	);
}

/**
 * A reducer that returns the state it was given writes nothing, so a superseded run's late row notifies nobody.
 * A run leaves the sort alone: the column sort the user chose holds across runs (owner ruling, ticket 582).
 */
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

/** The sort a table's head chose; the same sort again notifies nobody. */
export function setSort(store: UpgradesStore, next: ResultsSort): void {
	if (next !== store.getState().sort) store.setState({ sort: next });
}

/** One view toggle as the user set it; setting it to what it already is notifies nobody. */
export function setViewToggle(store: UpgradesStore, toggle: keyof ViewToggles, on: boolean): void {
	const { view } = store.getState();
	if (view[toggle] !== on) store.setState({ view: { ...view, [toggle]: on } });
}

/** The export panel's token or gear choice; the same choice again notifies nobody. */
export function setExportFlavour(store: UpgradesStore, flavour: ExportFlavour): void {
	if (store.getState().exportFlavour !== flavour) store.setState({ exportFlavour: flavour });
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
export const selectSort = (state: UpgradesState): ResultsSort => state.sort;
export const selectViewToggles = (state: UpgradesState): ViewToggles => state.view;
export const selectExportFlavour = (state: UpgradesState): ExportFlavour => state.exportFlavour;
export const selectRunStatus = (state: UpgradesState): RunState['status'] => state.run.status;

/** The signature the result on screen was measured on; none while a run is in flight, which is never stale (ticket 560). */
export const selectSettledSignature = (state: UpgradesState): string | undefined =>
	state.run.status === 'done' || state.run.status === 'stopped' ? state.run.measuredOn?.inputsSignature : undefined;
