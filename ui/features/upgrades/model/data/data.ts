/**
 * The bundled per-spec EP weights (copies of wowsims presets; each file names its
 * source) and the page's candidate pool. EP only prefilters candidates and fills
 * gems, so weights from another phase are disclosed, not wrong.
 */

import type { PoolEntry } from '../engine/pool';
import type { ContentPhase, SpecId } from '../engine/types';
import { bisSetsFor, buildPool, itemPhaseLookup, type PoolHost, presetPhase, presetSetOf, twinIdsOf } from '../pool_source';
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

/** A bundled EP-weights set: one per spec, plus Survival on the hunter page and Arms on the warrior page. */
export type EpWeightsSet = SpecId | 'hunter-sv' | 'warrior-arms';

/**
 * The build whose set replaces the spec's on its page, marked by a talent tree with
 * strictly more points than each other, not by gear (so Arms - Kebab takes Arms).
 * Tree indexes follow the talents string: hunter BM, MM, SV; warrior Arms, Fury, Prot.
 */
const TALENT_VARIANT_BY_SPEC: Partial<Record<SpecId, { set: EpWeightsSet; tree: number }>> = {
	hunter: { set: 'hunter-sv', tree: 2 },
	warrior: { set: 'warrior-arms', tree: 0 },
};

/** The set a run on `spec`'s page takes, given the page's `player.getTalentTreePoints()`. */
export function epWeightsSetFor(spec: SpecId, talentPointsByTree: readonly number[]): EpWeightsSet {
	const variant = TALENT_VARIANT_BY_SPEC[spec];
	if (!variant) return spec;
	const own = talentPointsByTree[variant.tree] ?? 0;
	const leads = own > 0 && talentPointsByTree.every((points, tree) => tree === variant.tree || points < own);
	return leads ? variant.set : spec;
}

/** One EP-weights set per spec, and per talent variant. */
// The files' shape is stated here, never derived from the JSON import.
export type EpWeightsFile = {
	weights: Record<string, number>;
	/** Keyed by wowsims `PseudoStat`; 0, 1 and 2 are main-hand, off-hand and ranged weapon DPS. */
	pseudoWeights?: Record<string, number>;
};

const EP_WEIGHTS_BY_SET: Record<EpWeightsSet, EpWeightsFile> = {
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

/**
 * The phase each bundled EP set was written for; `undefined` when the preset names
 * none (elemental's "Default"), which is still disclosed, as an unphased default.
 */
const EP_WEIGHTS_PHASE_BY_SET: Record<EpWeightsSet, number | undefined> = {
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
 * The EP-weights disclosure for `set`, or `undefined` when the weights match the
 * ranked phase. A mismatch degrades the shortlist but falsifies no DPS figure, so
 * it is disclosed, not blocked.
 */
export function epWeightsDisclosureFor(set: EpWeightsSet, maxPhase: ContentPhase): { from: string; requested: string } | undefined {
	const phase = EP_WEIGHTS_PHASE_BY_SET[set];
	if (phase === maxPhase) return undefined;
	return {
		from: phase === undefined ? 'an unphased default' : `P${phase}`,
		requested: `P${maxPhase}`,
	};
}

/** A wowsims preset gear set as the page holds it (`individualConfig.presets.gear`). */
export type PagePreset = { name: string; phase?: number; group?: string; gear: { items: readonly { id: number }[] } };

/** The page parts the pool reads: its database and spec, and its spec's preset gear sets. */
export type PagePoolHost = PoolHost & { individualConfig: { presets: { gear: readonly PagePreset[] } } };

/** The page's candidate pool at `maxPhase` over `presets` (the page's `individualConfig.presets.gear`); empty until the sim's database has loaded. */
export function poolFor(host: PoolHost, presets: readonly PagePreset[], maxPhase: ContentPhase): readonly PoolEntry[] {
	if (!host.sim.db) return [];
	return buildPool(host, presets.map(presetSetOf), maxPhase);
}

/** `twinIdsOf` over the page's database, for the settings' set matching; empty until the database has loaded. */
export const twinIdsFor = (host: PoolHost): ReadonlyMap<number, readonly number[]> => (host.sim.db ? twinIdsOf(host.sim.db.getAllItems()) : new Map());

/**
 * Where a run's pool came from and how many entries it has, for the
 * assumptions line; `undefined` for an empty pool, which is a phase with
 * nothing to rank rather than a ranking with no upgrades.
 */
export function poolSourceFor(pool: readonly PoolEntry[]): { name: string; entries: number } | undefined {
	return pool.length > 0 ? { name: 'wowsims db', entries: pool.length } : undefined;
}

/** Each preset with its phase as the pool reads it: declared, else its newest item's (`presetPhase`). */
export function presetsWithPhase<P extends PagePreset>(host: PoolHost, presets: readonly P[]): P[] {
	const itemPhaseOf = itemPhaseLookup(host);
	return presets.map(preset => {
		const phase = presetPhase(presetSetOf(preset), itemPhaseOf);
		return phase === preset.phase ? preset : { ...preset, phase };
	});
}

/**
 * The phase the pool's BiS tags speak for, or `undefined` when no preset is a BiS
 * set at or below `maxPhase`. It is earlier than `maxPhase` where the spec's
 * presets stop short, and the assumptions line then says so.
 */
export function bisTagPhaseFor(
	host: PoolHost,
	presets: readonly PagePreset[],
	maxPhase: ContentPhase,
): { tagsFromPhase: number; requestedPhase: number } | undefined {
	const bis = bisSetsFor(presets.map(presetSetOf), maxPhase, itemPhaseLookup(host));
	return bis ? { tagsFromPhase: bis.phase, requestedPhase: maxPhase } : undefined;
}

/** How many pool entries have no recorded source. */
export function unsourcedCountFor(pool: readonly PoolEntry[]): number {
	return pool.filter(e => (e.sources ?? [e.source]).every(s => s.kind === 'unknown')).length;
}

/** A bundled set (`epWeightsSetFor`): its EP weights and its pseudo-stat weights. */
export function epWeightsFileFor(set: EpWeightsSet): Readonly<EpWeightsFile> {
	return EP_WEIGHTS_BY_SET[set];
}

/** The EP weights of a bundled set (`epWeightsSetFor`). */
export function epWeightsFor(set: EpWeightsSet): Readonly<Record<string, number>> {
	return EP_WEIGHTS_BY_SET[set].weights;
}
