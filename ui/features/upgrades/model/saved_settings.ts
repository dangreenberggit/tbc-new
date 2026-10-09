/**
 * The Upgrades tab's settings, column sort and view toggles, kept across page reloads the
 * way upstream keeps the sim's own settings (`ui/sim/state/persistence.ts`):
 * through the sim's `Env` storage, under a per-spec key, read once when the
 * store is made and written on every change after.
 */

import type { Env } from '@sim/state/env';

import { SORT_COLUMN_IDS } from './results_columns';
import { NO_VIEW_TOGGLES } from './results_view';
import { createUpgradesStore, type RestoredTab, type ResultsSort, type SettingsSeed, type UpgradesState, type UpgradesStore } from './upgrades_store';

/** The key suffix the page's spec prefix goes in front of, as upstream's `__savedGear__` and the rest. */
export const UPGRADES_SETTINGS_STORAGE_KEY = '__upgradesSettings__';

/**
 * Bumped when a field changes meaning. A new field needs no bump: an entry
 * saved before it reads back without it and the field takes its default, as
 * `view` did. Upstream migrates an old saved proto (`updateProtoVersion`);
 * this tab has no migration yet, so another version reads back as nothing saved.
 */
const SAVED_VERSION = 1;

type Storage = Env['storage'];
type Settings = UpgradesState['settings'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');
const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** Each field reads back on its own, as a proto field upstream reads with `ignoreUnknownFields`: one bad field costs only itself. */
const FIELD_CHECKS: { [K in keyof Settings]-?: (value: unknown) => boolean } = {
	excludedSources: isStringList,
	selectedSetKeys: isStringList,
	prune: value => typeof value === 'boolean',
	candidateCap: value => isCount(value) && value > 0,
	iterations: isCount,
	defaultsFor: value => typeof value === 'string',
};

const restoredSettings = (saved: unknown): Partial<Settings> | undefined => {
	if (!isRecord(saved)) return undefined;
	const settings: Record<string, unknown> = {};
	for (const [field, check] of Object.entries(FIELD_CHECKS)) {
		if (check(saved[field])) settings[field] = saved[field];
	}
	return settings as Partial<Settings>;
};

const restoredView = (saved: unknown): RestoredTab['view'] => {
	if (!isRecord(saved)) return undefined;
	const view: Record<string, boolean> = {};
	for (const toggle of Object.keys(NO_VIEW_TOGGLES)) {
		if (typeof saved[toggle] === 'boolean') view[toggle] = saved[toggle];
	}
	return view;
};

// The results table sorts on one column at a time (`useResultsTable`), so a stored sort is empty or one known column.
const restoredSort = (saved: unknown): ResultsSort | undefined => {
	if (!Array.isArray(saved) || saved.length > 1) return undefined;
	const valid = saved.every(entry => isRecord(entry) && (SORT_COLUMN_IDS as readonly unknown[]).includes(entry.id) && typeof entry.desc === 'boolean');
	return valid ? saved.map(({ id, desc }) => ({ id, desc })) : undefined;
};

/** What the page saved under `key`, or nothing when there is none, it is unreadable, or storage is blocked. */
function readSavedTab(storage: Storage, key: string): RestoredTab {
	let saved: unknown;
	try {
		const raw = storage.getItem(key);
		if (raw === null) return {};
		saved = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!isRecord(saved) || saved.version !== SAVED_VERSION) return {};
	return { settings: restoredSettings(saved.settings), sort: restoredSort(saved.sort), view: restoredView(saved.view) };
}

const savedTabOf = ({ settings, sort, view }: UpgradesState) => ({ version: SAVED_VERSION, settings, sort, view });

/** The dev link's iterations and cap (`utils/dev_flags.ts`); a field the link does not set is absent. */
export type LinkedSettings = Partial<Pick<Settings, 'iterations' | 'candidateCap'>>;

/**
 * A new store over the page's saved settings, sort and view toggles, saving
 * each later change to any of them. A run changes neither, so a run writes nothing. The load
 * order is upstream's (`persistence.ts`): defaults, then saved, then the link.
 */
export function openSavedUpgradesStore(seed: SettingsSeed, storage: Storage, key: string, link: LinkedSettings = {}): UpgradesStore {
	const saved = readSavedTab(storage, key);
	const store = createUpgradesStore(seed, { ...saved, settings: { ...saved.settings, ...link } });
	store.subscribe((state, previous) => {
		if (state.settings === previous.settings && state.sort === previous.sort && state.view === previous.view) return;
		try {
			storage.setItem(key, JSON.stringify(savedTabOf(state)));
		} catch {
			// Blocked or full storage: the tab keeps working and forgets the change on reload.
		}
	});
	return store;
}
