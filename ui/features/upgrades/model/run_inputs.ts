/**
 * What a shown result was measured on, as a string: the page's run inputs and
 * the tab's settings. A run records it when it starts; the result is stale once
 * the same string built from the page now differs. Pure.
 */

import { Raid as RaidProto } from '@generated/proto/api';
import { Encounter as EncounterProto } from '@generated/proto/common';

import type { RunSettings } from './run_state';

/** The parts of the sim the key reads; the page's `Sim` is one. */
export type LiveInputsSource = {
	raid: { toProto(forExport?: boolean): RaidProto };
	encounter: { toProto(): EncounterProto };
	getPhase(): number;
};

/**
 * Every player setting a run reads (gear, talents, rotation, consumables, buffs),
 * the raid, the encounter and the phase. `toProto(true)` on purpose: without it the
 * proto embeds the worn gear's item database and rebuilds the rotation, and this
 * runs on every store notification.
 */
export const pageInputsSignature = (sim: LiveInputsSource): string =>
	JSON.stringify({
		raid: RaidProto.toJson(sim.raid.toProto(true)),
		encounter: EncounterProto.toJson(sim.encounter.toProto()),
		phase: sim.getPhase(),
	});

const sortedStrings = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
const sortedNumbers = (xs: readonly number[] | undefined) => [...(xs ?? [])].sort((a, b) => a - b);

/** The lists are sorted: ticking A then B is the same setting as B then A. */
export const inputsSignature = ({ liveKey, settings }: { liveKey: string; settings: RunSettings }): string =>
	JSON.stringify({
		live: liveKey,
		iterations: settings.iterations,
		candidateCap: settings.candidateCap ?? null,
		excludedSources: sortedStrings(settings.excludedSources),
		selectedGearSetKeys: sortedStrings(settings.selectedGearSetKeys),
		selectedGearSetItemIds: sortedNumbers(settings.selectedGearSetItemIds),
		prune: settings.prune ?? false,
	});
