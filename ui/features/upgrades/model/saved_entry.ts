/**
 * Where the Upgrades tab's saved entry lives, and the one edit the page makes to it without the tab's store. Small
 * and free of the tab's code and data on purpose: the eager `UpgradesTabBody` reaches it through `phase_changes.ts`,
 * so a page whose tab never opens downloads neither (ticket 589). `saved_settings.ts` reads and writes the whole entry.
 */

import type { Env } from '@sim/state/env';

/** The key suffix the page's spec prefix goes in front of, as upstream's `__savedGear__` and the rest. */
export const UPGRADES_SETTINGS_STORAGE_KEY = '__upgradesSettings__';

/**
 * Bumped when a field changes meaning. A new field needs no bump: an entry
 * saved before it reads back without it and the field takes its default, as
 * `view` did. Upstream migrates an old saved proto (`updateProtoVersion`);
 * this tab has no migration yet, so another version reads back as nothing saved.
 */
export const SAVED_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A phase change made while no tab store follows the phase: the saved entry forgets its sets and the scope they were
 * applied for, as the store's `changeScope` would, so the tab applies the new phase's default sets when it next
 * opens, on this page or after a reload. Everything else saved stays. Unlike `changeScope`, it cannot drop an
 * exclusion the new phase's pool does not offer, because that needs the tab's data; the store drops such an
 * exclusion against the page's phase when it opens (`appliedSettings`, `dropUnofferedSources`). An entry that is
 * missing, unreadable or of another version is left alone: the tab reads it as nothing saved and starts from the
 * defaults anyway.
 */
export function forgetSavedSets(storage: Env['storage'], key: string): void {
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
