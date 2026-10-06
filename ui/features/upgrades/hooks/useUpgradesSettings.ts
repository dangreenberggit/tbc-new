import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import { useSimHost } from '@sim/context/SimHostContext';
import { useSimStore } from '@sim/hooks/useSimStore';
import { type Dispatch, useMemo, useReducer, useState } from 'react';

import { bisTagPhaseFor, poolFor } from '../model/data/data';
import type { ContentPhase } from '../model/engine/types';
import { specIdFor } from '../model/run';
import { type SettingsOffer, settingsOffer, type SettingsView, settingsView } from '../model/settings_pool';
import { initialSettings, type SettingsAction, settingsReducer, type SettingsState } from '../model/settings_reducer';

/**
 * A number field's value holder, which a `NumberPicker` reads as its model.
 * One object for the tab's lifetime: the picker re-reads it on its own
 * notification, before this hook's next render, so it must already hold the
 * value the user typed (`ui-kit/input.ts`, `getValue`).
 */
export type NumberField = { current: number };

export type UpgradesSettings = Omit<SettingsView, 'eligibleCount'> & {
	state: SettingsState;
	dispatch: Dispatch<SettingsAction>;
	sources: SettingsOffer['sources'];
	/** Undefined when the page's spec has no ranking data. */
	eligibleCount: number | undefined;
	iterationsField: NumberField;
	capField: NumberField;
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
	// Memoised for the same renders: the effective pool is a filter over the whole pool.
	const view = useMemo(() => settingsView(offer, state, phase), [offer, state, phase]);

	const scope = specId && `${specId}:${phase}`;
	if (scope && state.defaultsFor !== scope) {
		dispatch({ type: 'applyDefaults', key: scope, selectedSetKeys: offer.defaultKeys, validSourceKeys: offer.sourceKeys });
	}

	return {
		...view,
		state,
		dispatch,
		sources: offer.sources,
		eligibleCount: specId ? view.eligibleCount : undefined,
		iterationsField,
		capField,
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
