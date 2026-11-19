/**
 * Where the tab's saved entry lives, and the one edit the page makes to it without the tab's store. Free of the
 * tab's code and data on purpose: the eager `UpgradesTabBody` reaches it through `phase_changes.ts`, so a page whose
 * tab never opens downloads neither. `saved_settings.ts` reads and writes the whole entry.
 */

import type { Env } from '@sim/state/env';

import { isRecord } from '../utils/is_record';

/** The key suffix the page's spec prefix goes in front of, as for `__savedGear__` and the rest. */
export const UPGRADES_SETTINGS_STORAGE_KEY = '__upgradesSettings__';

/**
 * Bumped when a field changes meaning; a new field needs none, as an entry without
 * it reads back with the default. Unlike wowsims (`updateProtoVersion`) the tab has
 * no migration, so another version reads back as nothing saved. In version 2 a
 * stored default-off source key, such as "Heroic dungeon", means ticked.
 */
export const SAVED_VERSION = 2;

/**
 * A phase change made while no tab store follows: the saved entry forgets its gear sets and the `spec:phase` they were
 * for, as `changeScope` would, so the tab applies the new phase's defaults when it next opens. Unlike `changeScope`
 * it cannot drop an exclusion the new pool does not offer, as that needs the tab's data; the store does that when it
 * opens (`dropUnofferedExclusions`). An entry missing, unreadable or of another version is left alone, as it reads back
 * as nothing saved.
 */
export function forgetSelectedGearSets(storage: Env['storage'], key: string): void {
	try {
		const raw = storage.getItem(key);
		if (raw === null) return;
		const saved: unknown = JSON.parse(raw);
		if (!isRecord(saved) || saved.version !== SAVED_VERSION || !isRecord(saved.settings)) return;
		const { defaultsFor: _forgotten, ...settings } = saved.settings;
		storage.setItem(key, JSON.stringify({ ...saved, settings: { ...settings, selectedSetKeys: [] } }));
	} catch {
		// Blocked or full storage loses the change, as a failed store write does; an entry that is not JSON reads back as nothing saved.
	}
}
