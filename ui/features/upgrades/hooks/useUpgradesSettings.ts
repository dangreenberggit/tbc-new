import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import { useSimHost } from '@sim/context/SimHostContext';
import { useSimStore } from '@sim/hooks/useSimStore';
import { useMemo, useReducer, useState } from 'react';

import { bisTagPhaseFor, poolFor } from '../model/data/data';
import type { ContentPhase } from '../model/engine/types';
import { specIdFor } from '../model/run';
import type { RunSettings } from '../model/run_reducer';
import { eligibleCountOf, runSettingsOf, type SetSelection, setSelection, type SettingsOffer, settingsOffer } from '../model/settings_pool';
import { initialSettings, settingsReducer } from '../model/settings_reducer';

/**
 * A number field's value holder, which a `NumberPicker` reads as its model.
 * One object for the tab's lifetime: the picker re-reads it on its own
 * notification, before this hook's next render, so it must already hold the
 * value the user typed (`ui-kit/input.ts`, `getValue`).
 */
export type NumberField = { current: number };

export type UpgradesSettings = Omit<SetSelection, 'selectedItemIds'> & {
	runSettings: RunSettings;
	sources: SettingsOffer['sources'];
	excludedSources: readonly string[];
	prune: boolean;
	/** Undefined when the page's spec has no ranking data. */
	eligibleCount: number | undefined;
	iterationsField: NumberField;
	capField: NumberField;
	toggleSource: (key: string) => void;
	toggleSet: (key: string) => void;
	setPrune: (prune: boolean) => void;
	onIterationsChange: (iterations: number) => void;
	onCapChange: (cap: number) => void;
};

/**
 * The tab's run settings over the page's spec, phase, gear presets and saved
 * gear sets. The default sets are applied once per spec and phase, during
 * render, so a phase change re-selects them before anything shows.
 */
export function useUpgradesSettings(seed: { iterations: number; candidateCap?: number }): UpgradesSettings {
	const host = useSimHost();
	const specId = specIdFor(host.player.getSpec());
	const phase = useSimStore('phase') as ContentPhase;
	const presets = host.individualConfig.presets.gear;
	const saved = useSavedGear().entries;
	const [state, dispatch] = useReducer(settingsReducer, seed, initialSettings);
	const [iterationsField] = useState<NumberField>(() => ({ current: seed.iterations }));
	const [capField] = useState<NumberField>(() => ({ current: seed.candidateCap ?? 0 }));

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

	const scope = specId && `${specId}:${phase}`;
	if (scope && state.defaultsFor !== scope) {
		dispatch({ type: 'applyDefaults', key: scope, selectedSetKeys: offer.defaultKeys, validSourceKeys: offer.sourceKeys });
	}

	return {
		selectedOptions: selection.selectedOptions,
		selectedKeys: selection.selectedKeys,
		chips: selection.chips,
		runSettings,
		sources: offer.sources,
		excludedSources: state.excludedSources,
		prune: state.prune,
		eligibleCount: specId ? eligibleCount : undefined,
		iterationsField,
		capField,
		toggleSource: key => dispatch({ type: 'toggleSource', key }),
		toggleSet: key => dispatch({ type: 'toggleSet', key }),
		setPrune: prune => dispatch({ type: 'setPrune', prune }),
		onIterationsChange: iterations => {
			iterationsField.current = iterations;
			dispatch({ type: 'setIterations', iterations });
		},
		onCapChange: cap => {
			capField.current = cap;
			dispatch({ type: 'setCandidateCap', cap });
		},
	};
}
