import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import { ItemSlot } from '@generated/proto/common';
import { useSimHost, useSpecPresets } from '@sim/context/SimHostContext';
import { usePlayerStore } from '@sim/hooks/usePlayerStore';
import { useSimReady } from '@sim/hooks/useSimReady';
import { useSimStore } from '@sim/hooks/useSimStore';
import { useMemo } from 'react';
import { useStore } from 'zustand';

import { bisTagPhaseFor, poolFor, presetsWithPhase } from '../model/data/data';
import type { ContentPhase } from '../model/engine/types';
import { specIdFor } from '../model/run';
import type { RunSettings } from '../model/run_state';
import {
	effectiveExcludedSources,
	eligibleCountOf,
	runSettingsOf,
	type SetSelection,
	setSelection,
	type SettingsOffer,
	settingsOffer,
} from '../model/settings_pool';
import { appliedSettings, type SettingsScope } from '../model/settings_state';
import type { UpgradesStore } from '../model/upgrades_store';
import { useUpgradesStoreApi } from './useUpgradesStore';

export type UpgradesSettings = Omit<SetSelection, 'selectedItemIds'> & {
	runSettings: RunSettings;
	sources: SettingsOffer['sources'];
	excludedSources: readonly string[];
	prune: boolean;
	/** Undefined when the page's spec has no ranking data. */
	eligibleCount: number | undefined;
	/** The tab's store, which the number pickers read their value from. */
	store: UpgradesStore;
	toggleSource: (key: string) => void;
	toggleSet: (key: string) => void;
	setPrune: (prune: boolean) => void;
	setIterations: (iterations: number) => void;
	setCandidateCap: (cap: number) => void;
};

/**
 * The tab's effective run settings over the page's spec, phase, gear presets
 * and saved gear sets, for any component on the page (ticket 564). The default
 * sets of the page's spec and phase are a derivation over the stored settings,
 * so every caller shows them from the first render and right after a phase
 * change; the first write stores them along with the user's change.
 */
export function useUpgradesSettings(): UpgradesSettings {
	const host = useSimHost();
	const specId = specIdFor(host.player.getSpec());
	const phase = useSimStore('phase') as ContentPhase;
	// `?.` on the gear: the player's slice is missing between Player.dispose() and its deferred delete (usePlayerStore).
	const wornMainHandId = usePlayerStore('gear')?.getEquippedItem(ItemSlot.ItemSlotMainHand)?.id;
	const presets = useSpecPresets().gear;
	// The pool is built from the sim's item database, which loads after the page first renders.
	const ready = useSimReady();
	const saved = useSavedGear().entries;
	const store = useUpgradesStoreApi();
	const stored = useStore(store, state => state.settings);
	const toggleSource = useStore(store, state => state.toggleSource);
	const toggleSet = useStore(store, state => state.toggleSet);
	const setPrune = useStore(store, state => state.setPrune);
	const setIterations = useStore(store, state => state.setIterations);
	const setCandidateCap = useStore(store, state => state.setCandidateCap);

	// Memoised: `poolFor` builds a new pool on each call, and the tab renders again on every row a run lands.
	const offer = useMemo(() => {
		const phasedPresets = ready ? presetsWithPhase(host, presets) : presets;
		return settingsOffer({
			pool: specId && ready ? poolFor(host, phasedPresets, phase) : [],
			presets: phasedPresets,
			savedSets: saved.map(entry => ({ name: entry.name, gear: entry.data.gear })),
			bisTagPhase: specId && ready ? bisTagPhaseFor(host, phasedPresets, phase)?.tagsFromPhase : undefined,
		});
	}, [specId, ready, host, phase, presets, saved]);
	const scope = useMemo(
		(): SettingsScope | undefined =>
			specId ? { key: `${specId}:${phase}`, selectedSetKeys: offer.defaultKeys, validSourceKeys: offer.sourceKeys } : undefined,
		[specId, phase, offer],
	);
	// Memoised for the same renders: until a write stores the defaults, the derivation builds a new state on each
	// call, and the selection and eligible count below key on its fields.
	const applied = useMemo(() => appliedSettings(stored, scope), [stored, scope]);
	// The exclusions as shown and run: the stored toggles read against the sources that start unticked.
	const state = useMemo(
		() => ({ ...applied, excludedSources: effectiveExcludedSources(applied.excludedSources, offer.sourceKeys) }),
		[applied, offer.sourceKeys],
	);
	// Memoised on the picked sets alone, so it keeps its identity while other settings change: the results
	// area builds its row badges from it, and a new selection renders every row again.
	const selection = useMemo(() => setSelection(offer, state.selectedSetKeys, phase), [offer, state.selectedSetKeys, phase]);
	// Memoised, as is the result below, so a render that changes no setting (a row a run lands) hands the run card
	// the same settings and its `memo` skips the render (review K2-4).
	const runSettings = useMemo(() => runSettingsOf(selection, state), [selection, state]);
	const { excludedSources } = state;
	const effectivePrune = runSettings.prune ?? false;
	// Memoised for the same renders, on the pool filters alone: the effective pool is a filter over the whole pool,
	// which an iterations or cap keystroke must not run again.
	const eligibleCount = useMemo(
		() =>
			eligibleCountOf(offer, { excludedSources, selectedSetItemIds: selection.selectedItemIds, prune: effectivePrune }, phase, {
				spec: specId,
				wornMainHandId,
			}),
		[offer, excludedSources, selection, effectivePrune, phase, specId, wornMainHandId],
	);

	return useMemo(
		(): UpgradesSettings => ({
			selectedOptions: selection.selectedOptions,
			selectedKeys: selection.selectedKeys,
			chips: selection.chips,
			runSettings,
			sources: offer.sources,
			excludedSources,
			prune: state.prune,
			eligibleCount: specId ? eligibleCount : undefined,
			store,
			toggleSource: key => toggleSource(key, scope),
			toggleSet: key => toggleSet(key, scope),
			setPrune: prune => setPrune(prune, scope),
			setIterations: iterations => setIterations(iterations, scope),
			setCandidateCap: cap => setCandidateCap(cap, scope),
		}),
		[
			selection,
			runSettings,
			offer,
			excludedSources,
			state.prune,
			specId,
			eligibleCount,
			store,
			scope,
			toggleSource,
			toggleSet,
			setPrune,
			setIterations,
			setCandidateCap,
		],
	);
}
