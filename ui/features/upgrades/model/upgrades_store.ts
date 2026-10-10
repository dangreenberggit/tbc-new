/**
 * The Upgrades tab's state as a zustand store, one per page `Sim` (ticket
 * 564), built the way upstream's sim store is (`ui/sim/state/sim_store.ts`).
 * Its actions live in the store next to the state, as zustand recommends
 * (https://zustand.docs.pmnd.rs/learn/guides/practice-with-no-store-actions);
 * each one takes its next state from a pure function in `run_state.ts` or
 * `settings_state.ts`, which the unit tests check without a store.
 */

import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type { RankedItem, Ranking } from './engine/rank';
import type { ExportFlavour } from './export';
import { NO_VIEW_TOGGLES, type ViewToggles } from './results_view';
import {
	fixtureLoaded,
	IDLE_RUN,
	type MeasuredOn,
	rowLanded,
	runFailed,
	type RunOutcome,
	runSettled,
	runStarted,
	type RunState,
	stopRequested,
} from './run_state';
import {
	afterScopeChange,
	appliedSettings,
	initialSettings,
	type SettingsScope,
	type SettingsState,
	withCandidateCap,
	withIterations,
	withoutUnofferedSources,
	withPrune,
	withSetToggled,
	withSourceToggled,
} from './settings_state';

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
export type UpgradesData = { run: RunState; settings: SettingsState; sort: ResultsSort; view: ViewToggles; exportFlavour: ExportFlavour };

/**
 * An action whose pure function returns the state it was given writes nothing, so a superseded run's late row, or a
 * write that changes nothing, notifies nobody.
 */
export type UpgradesActions = {
	/** The run's id comes from the run session (`run_session.ts`), which tells a superseded run's callbacks apart by it. */
	startRun: (runId: number, startedAt: number, measuredOn?: MeasuredOn) => void;
	loadFixture: (runId: number, ranking: Ranking, measuredOn?: MeasuredOn) => void;
	landRow: (runId: number, row: RankedItem) => void;
	requestStop: (runId: number) => void;
	settleRun: (runId: number, outcome: RunOutcome) => void;
	failRun: (runId: number, message: string) => void;
	/**
	 * The user's settings changes. Each applies the scope's default sets first, so the stored state matches what the
	 * tab showed (`appliedSettings`), and writes both in one notification. The scope is required, though it may be
	 * undefined, so a caller cannot forget it and store a change the next render's defaults would overwrite.
	 */
	toggleSource: (key: string, scope: SettingsScope | undefined) => void;
	toggleSet: (key: string, scope: SettingsScope | undefined) => void;
	setPrune: (prune: boolean, scope: SettingsScope | undefined) => void;
	setIterations: (iterations: number, scope: SettingsScope | undefined) => void;
	setCandidateCap: (cap: number | undefined, scope: SettingsScope | undefined) => void;
	applyDefaults: (scope: SettingsScope) => void;
	/** The page's changes: a phase change, and the pool the page's phase offers once it has loaded (`follow_phase.ts`). */
	changeScope: (validSourceKeys: readonly string[]) => void;
	dropUnofferedSources: (validSourceKeys: readonly string[]) => void;
	setSort: (sort: ResultsSort) => void;
	setViewToggle: (toggle: keyof ViewToggles, on: boolean) => void;
	setExportFlavour: (flavour: ExportFlavour) => void;
};

export type UpgradesState = UpgradesData & UpgradesActions;

/** The settings a new store starts from, before the page's saved entry and the dev link go over them (`saved_settings.ts`). */
export type SettingsSeed = { iterations: number };

/** What a store restores from storage over its seed: only the fields that read back valid. */
export type RestoredTab = { settings?: Partial<SettingsState>; sort?: ResultsSort; view?: Partial<ViewToggles>; exportFlavour?: ExportFlavour };

export type UpgradesStore = ReturnType<typeof createUpgradesStore>;

export function createUpgradesStore(seed: SettingsSeed, restored: RestoredTab = {}) {
	return createStore<UpgradesState>()(
		subscribeWithSelector((set): UpgradesState => {
			// Returning the same state object is what makes zustand skip the write and the notification.
			const setRun = (next: (run: RunState) => RunState) =>
				set(state => {
					const run = next(state.run);
					return run === state.run ? state : { run };
				});
			const setSettings = (next: (settings: SettingsState) => SettingsState) =>
				set(state => {
					const settings = next(state.settings);
					return settings === state.settings ? state : { settings };
				});
			const changeInScope = (scope: SettingsScope | undefined, change: (settings: SettingsState) => SettingsState) =>
				setSettings(settings => change(appliedSettings(settings, scope)));

			return {
				run: IDLE_RUN,
				settings: { ...initialSettings(seed), ...restored.settings },
				sort: restored.sort ?? [],
				view: { ...NO_VIEW_TOGGLES, ...restored.view },
				// The token is the default: the raid awards the token, not the tier piece.
				exportFlavour: restored.exportFlavour ?? 'token',

				// A run leaves the sort alone: the column sort the user chose holds across runs (owner ruling, ticket 582).
				startRun: (runId, startedAt, measuredOn) => setRun(() => runStarted(runId, startedAt, measuredOn)),
				loadFixture: (runId, ranking, measuredOn) => setRun(() => fixtureLoaded(runId, ranking, measuredOn)),
				landRow: (runId, row) => setRun(run => rowLanded(run, runId, row)),
				requestStop: runId => setRun(run => stopRequested(run, runId)),
				settleRun: (runId, outcome) => setRun(run => runSettled(run, runId, outcome)),
				failRun: (runId, message) => setRun(run => runFailed(run, runId, message)),

				toggleSource: (key, scope) => changeInScope(scope, settings => withSourceToggled(settings, key)),
				toggleSet: (key, scope) => changeInScope(scope, settings => withSetToggled(settings, key)),
				setPrune: (prune, scope) => changeInScope(scope, settings => withPrune(settings, prune)),
				setIterations: (iterations, scope) => changeInScope(scope, settings => withIterations(settings, iterations)),
				setCandidateCap: (cap, scope) => changeInScope(scope, settings => withCandidateCap(settings, cap)),
				applyDefaults: scope => setSettings(settings => appliedSettings(settings, scope)),
				changeScope: validSourceKeys => setSettings(settings => afterScopeChange(settings, validSourceKeys)),
				dropUnofferedSources: validSourceKeys => setSettings(settings => withoutUnofferedSources(settings, validSourceKeys)),

				setSort: sort => set(state => (sort === state.sort ? state : { sort })),
				setViewToggle: (toggle, on) => set(state => (state.view[toggle] === on ? state : { view: { ...state.view, [toggle]: on } })),
				setExportFlavour: flavour => set(state => (flavour === state.exportFlavour ? state : { exportFlavour: flavour })),
			};
		}),
	);
}

export const selectRun = (state: UpgradesState): RunState => state.run;
export const selectSort = (state: UpgradesState): ResultsSort => state.sort;
export const selectViewToggles = (state: UpgradesState): ViewToggles => state.view;
export const selectExportFlavour = (state: UpgradesState): ExportFlavour => state.exportFlavour;
export const selectRunStatus = (state: UpgradesState): RunState['status'] => state.run.status;

/** The signature the result on screen was measured on; none while a run is in flight, which is never stale (ticket 560). */
export const selectSettledSignature = (state: UpgradesState): string | undefined =>
	state.run.status === 'done' || state.run.status === 'stopped' ? state.run.measuredOn?.inputsSignature : undefined;
