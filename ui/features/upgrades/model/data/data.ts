/**
 * The bundled per-spec EP weights (copies of wowsims presets; each file names its
 * source) and the page's candidate pool. EP only orders candidates and picks gems,
 * so weights written for another phase are reported, not treated as wrong.
 */

import type { PoolEntry } from '../engine/pool';
import type { ContentPhase, SpecId } from '../engine/types';
import { bisGearSetsFor, buildPool, itemPhaseLookup, type PoolHost, presetGearSetOf, presetPhase, twinIdsOf } from '../pool_source';
import balanceEpWeights from './balance-fallback.ep-weights.json';
import eleEpWeights from './ele-fallback.ep-weights.json';
import enhEpWeights from './enh-fallback.ep-weights.json';
import feralEpWeights from './feral-p1.ep-weights.json';
import hunterEpWeights from './hunter-fallback.ep-weights.json';
import hunterSvEpWeights from './hunter-sv-p1.ep-weights.json';
import mageEpWeights from './mage-fallback.ep-weights.json';
import retEpWeights from './ret-p2.ep-weights.json';
import rogueEpWeights from './rogue-fallback.ep-weights.json';
import shadowEpWeights from './shadow-fallback.ep-weights.json';
import warlockEpWeights from './warlock-fallback.ep-weights.json';
import warriorArmsEpWeights from './warrior-arms-p3.ep-weights.json';
import warriorEpWeights from './warrior-fallback.ep-weights.json';

/** A bundled EP-weights preset: one per spec, plus Survival on the hunter page and Arms on the warrior page. */
export type EpWeightsPreset = SpecId | 'hunter-sv' | 'warrior-arms';

/**
 * The talent tree that switches a page to its second build's weights. Talents
 * decide, not gear: the tree needs strictly more points than each other tree, so
 * an Arms build with two one-handers still takes Arms. Tree indexes follow the
 * talents string: hunter Beast Mastery, Marksmanship, Survival; warrior Arms, Fury,
 * Protection.
 */
const TALENT_VARIANT_BY_SPEC: Partial<Record<SpecId, { preset: EpWeightsPreset; tree: number }>> = {
	hunter: { preset: 'hunter-sv', tree: 2 },
	warrior: { preset: 'warrior-arms', tree: 0 },
};

export function epWeightsPresetFor(spec: SpecId, talentPointsByTree: readonly number[]): EpWeightsPreset {
	const variant = TALENT_VARIANT_BY_SPEC[spec];
	if (!variant) return spec;
	const own = talentPointsByTree[variant.tree] ?? 0;
	const leads = own > 0 && talentPointsByTree.every((points, tree) => tree === variant.tree || points < own);
	return leads ? variant.preset : spec;
}

// The files' shape is stated here, never derived from the JSON import.
export type EpWeightsFile = {
	weights: Record<string, number>;
	/** Keyed by wowsims `PseudoStat`; 0, 1 and 2 are main-hand, off-hand and ranged weapon DPS. */
	pseudoWeights?: Record<string, number>;
};

const EP_WEIGHTS_BY_PRESET: Record<EpWeightsPreset, EpWeightsFile> = {
	ret: retEpWeights as EpWeightsFile,
	feral: feralEpWeights as EpWeightsFile,
	balance: balanceEpWeights as EpWeightsFile,
	hunter: hunterEpWeights as EpWeightsFile,
	mage: mageEpWeights as EpWeightsFile,
	shadow: shadowEpWeights as EpWeightsFile,
	rogue: rogueEpWeights as EpWeightsFile,
	ele: eleEpWeights as EpWeightsFile,
	enh: enhEpWeights as EpWeightsFile,
	warlock: warlockEpWeights as EpWeightsFile,
	warrior: warriorEpWeights as EpWeightsFile,
	// P1_SV_EP_PRESET, which has P1_BM_EP_PRESET's numbers.
	'hunter-sv': hunterSvEpWeights as EpWeightsFile,
	// P3_ARMS_EP_PRESET, not P1_ARMS_EP_PRESET: wowsims' phase 3-5 Arms builds use it
	// (`ui/specs/warrior/dps/presets.ts`), and the page opens at phase 3 (CURRENT_PHASE).
	'warrior-arms': warriorArmsEpWeights as EpWeightsFile,
};

/** `undefined` where the preset names no phase (elemental's "Default"); a run still reports it. */
const EP_WEIGHTS_PHASE_BY_PRESET: Record<EpWeightsPreset, number | undefined> = {
	ret: 2,
	feral: 1,
	balance: undefined,
	hunter: 1,
	mage: 1,
	shadow: 1,
	rogue: 1,
	ele: undefined,
	enh: undefined,
	warlock: 1,
	warrior: 1,
	'hunter-sv': 1,
	'warrior-arms': 3,
};

/**
 * A phase mismatch makes the candidate order worse but changes no DPS figure, so
 * it is reported, not blocked.
 */
export function epWeightsPhaseMismatch(preset: EpWeightsPreset, maxPhase: ContentPhase): { from: string; requested: string } | undefined {
	const phase = EP_WEIGHTS_PHASE_BY_PRESET[preset];
	if (phase === maxPhase) return undefined;
	return {
		from: phase === undefined ? 'an unphased default' : `P${phase}`,
		requested: `P${maxPhase}`,
	};
}

/** A wowsims preset gear set as the page holds it (`individualConfig.presets.gear`). */
export type PagePreset = { name: string; phase?: number; group?: string; gear: { items: readonly { id: number }[] } };

export type PagePoolHost = PoolHost & { individualConfig: { presets: { gear: readonly PagePreset[] } } };

export function poolFor(host: PoolHost, presets: readonly PagePreset[], maxPhase: ContentPhase): readonly PoolEntry[] {
	if (!host.sim.db) return [];
	return buildPool(host, presets.map(presetGearSetOf), maxPhase);
}

export const twinIdsFor = (host: PoolHost): ReadonlyMap<number, readonly number[]> => (host.sim.db ? twinIdsOf(host.sim.db.getAllItems()) : new Map());

/** `undefined` for an empty pool: a phase with nothing to rank, not a ranking with no upgrades. */
export function poolSourceFor(pool: readonly PoolEntry[]): { name: string; entries: number } | undefined {
	return pool.length > 0 ? { name: 'wowsims db', entries: pool.length } : undefined;
}

/** Gives each preset the phase the pool uses for it (`presetPhase`). */
export function presetsWithPhase<P extends PagePreset>(host: PoolHost, presets: readonly P[]): P[] {
	const itemPhaseOf = itemPhaseLookup(host);
	return presets.map(preset => {
		const phase = presetPhase(presetGearSetOf(preset), itemPhaseOf);
		return phase === preset.phase ? preset : { ...preset, phase };
	});
}

/**
 * The phase the pool's BiS tags come from. It is earlier than `maxPhase` where the
 * spec's presets stop short, and the assumptions line then says so.
 */
export function bisTagPhaseFor(
	host: PoolHost,
	presets: readonly PagePreset[],
	maxPhase: ContentPhase,
): { tagsFromPhase: number; requestedPhase: number } | undefined {
	const bis = bisGearSetsFor(presets.map(presetGearSetOf), maxPhase, itemPhaseLookup(host));
	return bis ? { tagsFromPhase: bis.phase, requestedPhase: maxPhase } : undefined;
}

export function unsourcedCountFor(pool: readonly PoolEntry[]): number {
	return pool.filter(e => (e.sources ?? [e.source]).every(s => s.kind === 'unknown')).length;
}

export function epWeightsFileFor(preset: EpWeightsPreset): Readonly<EpWeightsFile> {
	return EP_WEIGHTS_BY_PRESET[preset];
}

export function epWeightsFor(preset: EpWeightsPreset): Readonly<Record<string, number>> {
	return EP_WEIGHTS_BY_PRESET[preset].weights;
}
