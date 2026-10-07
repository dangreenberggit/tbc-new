import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import { useSimHost, useSpecPresets } from '@sim/context/SimHostContext';
import { useSimStore } from '@sim/hooks/useSimStore';
import { useMemo } from 'react';
import { useStore } from 'zustand';

import { bisTagPhaseFor, poolFor } from '../model/data/data';
import type { ContentPhase } from '../model/engine/types';
import { specIdFor } from '../model/run';
import type { RunSettings } from '../model/run_reducer';
import { eligibleCountOf, runSettingsOf, type SetSelection, setSelection, type SettingsOffer, settingsOffer } from '../model/settings_pool';
import type { SettingsAction } from '../model/settings_reducer';
import { appliedSettings, settingsActionIn, type SettingsDefaults, type UpgradesStore } from '../model/upgrades_store';
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

const defaultsOf = (offer: SettingsOffer): SettingsDefaults => ({ selectedSetKeys: offer.defaultKeys, validSourceKeys: offer.sourceKeys });

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
	const presets = useSpecPresets().gear;
	const saved = useSavedGear().entries;
	const store = useUpgradesStoreApi();
	const stored = useStore(store, state => state.settings);

	// Memoised: `poolFor` builds a new pool on each call, and the tab renders again on every row a run lands.
	const offer = useMemo(
		() =>
			settingsOffer({
				pool: specId ? poolFor(specId, phase) : [],
				presets,
				savedSets: saved.map(entry => ({ name: entry.name, gear: entry.data.gear })),
				bisTagPhase: specId ? bisTagPhaseFor(specId, phase)?.tagsFromPhase : undefined,
			}),
		[specId, phase, presets, saved],
	);
	const scope = specId ? `${specId}:${phase}` : undefined;
	// Memoised for the same renders: until a write stores the defaults, the derivation builds a new state on each
	// call, and the selection and eligible count below key on its fields.
	const state = useMemo(() => appliedSettings(stored, scope, defaultsOf(offer)), [stored, scope, offer]);
	// Memoised on the picked sets alone, so it keeps its identity while other settings change: the results
	// area builds its row badges from it, and a new selection renders every row again.
	const selection = useMemo(() => setSelection(offer, state.selectedSetKeys, phase), [offer, state.selectedSetKeys, phase]);
	const runSettings = runSettingsOf(selection, state);
	const { excludedSources } = state;
	const prune = runSettings.prune ?? false;
	// Memoised for the same renders, on the pool filters alone: the effective pool is a filter over the whole pool,
	// which an iterations or cap keystroke must not run again.
	const eligibleCount = useMemo(
		() => eligibleCountOf(offer, { excludedSources, selectedSetItemIds: selection.selectedItemIds, prune }, phase),
		[offer, excludedSources, selection, prune, phase],
	);

	const write = (action: SettingsAction) => settingsActionIn(store, scope, defaultsOf(offer), action);

	return {
		selectedOptions: selection.selectedOptions,
		selectedKeys: selection.selectedKeys,
		chips: selection.chips,
		runSettings,
		sources: offer.sources,
		excludedSources,
		prune: state.prune,
		eligibleCount: specId ? eligibleCount : undefined,
		store,
		toggleSource: key => write({ type: 'toggleSource', key }),
		toggleSet: key => write({ type: 'toggleSet', key }),
		setPrune: prune => write({ type: 'setPrune', prune }),
		setIterations: iterations => write({ type: 'setIterations', iterations }),
		setCandidateCap: cap => write({ type: 'setCandidateCap', cap }),
	};
}
