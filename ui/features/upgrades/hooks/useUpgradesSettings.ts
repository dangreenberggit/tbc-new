import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import { ItemSlot } from '@generated/proto/common';
import { useSimHost, useSpecPresets } from '@sim/context/SimHostContext';
import { usePlayerStore } from '@sim/hooks/usePlayerStore';
import { useSimReady } from '@sim/hooks/useSimReady';
import { useSimStore } from '@sim/hooks/useSimStore';
import { useMemo } from 'react';
import { useStore } from 'zustand';

import { bisTagPhaseFor, poolFor, presetsWithPhase, twinIdsFor } from '../model/data/data';
import type { ContentPhase } from '../model/engine/types';
import { specIdFor } from '../model/run';
import type { RunSettings } from '../model/run_state';
import {
	bisHeadingIndex,
	effectiveExcludedSources,
	eligibleCountOf,
	type GearSetSelection,
	gearSetSelection,
	runSettingsOf,
	type SettingsOffer,
	settingsOffer,
} from '../model/settings_pool';
import { appliedSettings, type SettingsScope } from '../model/settings_state';
import { selectSettledPhase, type UpgradesStore } from '../model/upgrades_store';
import { useUpgradesStoreApi } from './useUpgradesStore';

export type UpgradesSettings = Omit<GearSetSelection, 'selectedItemIds'> & {
	runSettings: RunSettings;
	sources: SettingsOffer['sources'];
	/** The headings a row's "BiS" badge names when the row is in no selected gear set, for the phase the ranking on screen ran at. */
	bisHeadingsOf: (itemId: number) => readonly string[];
	excludedSources: readonly string[];
	prune: boolean;
	/** Undefined when the page's spec has no ranking data. */
	eligibleCount: number | undefined;
	store: UpgradesStore;
	toggleExcludedSource: (key: string) => void;
	toggleGearSet: (key: string) => void;
	setPrune: (prune: boolean) => void;
	setIterations: (iterations: number) => void;
	setCandidateCap: (cap: number) => void;
};

/**
 * The tab's effective run settings over the page's spec, phase, gear presets and
 * saved gear sets. The default gear sets are derived over the stored settings, so every
 * caller shows them from the first render and right after a phase change; the
 * first write stores them along with the user's change.
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
	const toggleExcludedSource = useStore(store, state => state.toggleExcludedSource);
	const toggleGearSet = useStore(store, state => state.toggleGearSet);
	const setPrune = useStore(store, state => state.setPrune);
	const setIterations = useStore(store, state => state.setIterations);
	const setCandidateCap = useStore(store, state => state.setCandidateCap);

	const phasedPresets = useMemo(() => (ready ? presetsWithPhase(host, presets) : presets), [ready, host, presets]);
	// Memoised: `poolFor` builds a new pool on each call, and the tab renders again on every row a run finishes.
	const offer = useMemo(
		() =>
			settingsOffer({
				pool: specId && ready ? poolFor(host, phasedPresets, phase) : [],
				presets: phasedPresets,
				savedGearSets: saved.map(entry => ({ name: entry.name, gear: entry.data.gear })),
				bisTagPhase: specId && ready ? bisTagPhaseFor(host, phasedPresets, phase)?.tagsFromPhase : undefined,
				twins: specId && ready ? twinIdsFor(host) : undefined,
			}),
		[specId, ready, host, phase, phasedPresets, saved],
	);
	// A row's BiS tag comes from the ranking on screen, which keeps the phase it ran at through a later phase change.
	// While a run is in flight the page's phase is the run's: the progress dialog blocks the page until it settles.
	const rankedPhase = useStore(store, selectSettledPhase) ?? phase;
	const bisHeadingsOf = useMemo(
		() => bisHeadingIndex(offer.gearSetOptions, specId && ready ? bisTagPhaseFor(host, phasedPresets, rankedPhase)?.tagsFromPhase : undefined),
		[offer.gearSetOptions, specId, ready, host, phasedPresets, rankedPhase],
	);
	const scope = useMemo(
		(): SettingsScope | undefined =>
			specId ? { specPhase: `${specId}:${phase}`, defaultGearSetKeys: offer.defaultGearSetKeys, poolSourceKeys: offer.sourceKeys } : undefined,
		[specId, phase, offer],
	);
	// Until a write stores the defaults, `appliedSettings` builds a new state on each call, and the selection and
	// eligible count below key on its fields.
	const applied = useMemo(() => appliedSettings(stored, scope), [stored, scope]);
	// The exclusions as shown and run: the stored toggles read against the sources that start unticked.
	const effectiveSettings = useMemo(
		() => ({ ...applied, excludedSources: effectiveExcludedSources(applied.excludedSources, offer.sourceKeys) }),
		[applied, offer.sourceKeys],
	);
	// On the picked gear sets alone, so it keeps its identity while other settings change: the run settings and the
	// eligible count key on it.
	const selection = useMemo(() => gearSetSelection(offer, effectiveSettings.selectedSetKeys, phase), [offer, effectiveSettings.selectedSetKeys, phase]);
	// As is the result below, so a render that changes no setting hands `RunSettingsPanel` the same settings and
	// its `memo` skips the render.
	const runSettings = useMemo(() => runSettingsOf(selection, effectiveSettings), [selection, effectiveSettings]);
	const { excludedSources } = effectiveSettings;
	const effectivePrune = runSettings.prune ?? false;
	// On the pool filters alone: filtering the whole pool must not rerun on an iterations or cap keystroke.
	const eligibleCount = useMemo(
		() =>
			eligibleCountOf(offer, { excludedSources, selectedGearSetItemIds: selection.selectedItemIds, prune: effectivePrune }, phase, {
				spec: specId,
				wornMainHandId,
			}),
		[offer, excludedSources, selection, effectivePrune, phase, specId, wornMainHandId],
	);

	return useMemo(
		(): UpgradesSettings => ({
			selectedGearSets: selection.selectedGearSets,
			selectedKeys: selection.selectedKeys,
			chips: selection.chips,
			runSettings,
			sources: offer.sources,
			bisHeadingsOf,
			excludedSources,
			prune: effectiveSettings.prune,
			eligibleCount: specId ? eligibleCount : undefined,
			store,
			toggleExcludedSource: key => toggleExcludedSource(key, scope),
			toggleGearSet: key => toggleGearSet(key, scope),
			setPrune: prune => setPrune(prune, scope),
			setIterations: iterations => setIterations(iterations, scope),
			setCandidateCap: cap => setCandidateCap(cap, scope),
		}),
		[
			selection,
			runSettings,
			offer,
			bisHeadingsOf,
			excludedSources,
			effectiveSettings.prune,
			specId,
			eligibleCount,
			store,
			scope,
			toggleExcludedSource,
			toggleGearSet,
			setPrune,
			setIterations,
			setCandidateCap,
		],
	);
}
