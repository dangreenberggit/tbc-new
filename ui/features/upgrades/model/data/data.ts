/**
 * The data a run reads besides the page itself: the per-spec EP weights
 * (bundled JSON, copies of wowsims presets; the outer repo's
 * docs/fork-provenance/data.md records their sources) and the candidate pool,
 * which is built at run time from wowsims' own item database and the spec's
 * preset gear sets (`pool_source.ts`, ticket 505). No item list is bundled.
 *
 * EP drives only the candidate prefilter and the gem fill, never the ranking
 * numbers themselves, which sims produce, so a spec whose weights were written
 * for another phase is a disclosed degradation, not a wrong ranking.
 */

import type { PoolEntry } from '../engine/pool';
import type { ContentPhase, SpecId } from '../engine/types';
import { bisSetsFor, buildPool, itemPhaseLookup, type PoolHost, presetPhase, presetSetOf } from '../pool_source';
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

/**
 * A bundled EP-weights set: one per spec, plus the two builds that share a
 * page with another one (Survival on the hunter page, Arms on the warrior
 * page; ticket 803).
 */
export type EpWeightsSet = SpecId | 'hunter-sv' | 'warrior-arms';

/**
 * The build whose own set replaces the spec's on that spec's page, and the
 * talent tree that marks it. The page's talents decide, not its gear: the
 * build is the variant when that tree has strictly more points than each
 * other tree, and a tie or no talents keeps the spec's own set. So an
 * Arms - Kebab build (Mortal Strike with two one-handers, most points in
 * Arms) takes the Arms set. Tree indexes follow the talents string: hunter
 * Beast Mastery, Marksmanship, Survival; warrior Arms, Fury, Protection.
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

/**
 * One EP-weights set per spec, and per talent variant.
 *
 * The nine specs added by the all-DPS-specs pass each bundle their
 * `fallback` file — the entry `data/presets/ep-weights-by-phase.json` names
 * for a spec below its lowest `byPhase` key. A spec whose weights were
 * written for an earlier phase than the one being ranked is a real,
 * disclosed degradation, not a bug: EP drives only the candidate prefilter
 * and the gem fill, and every ranking number comes from the sim. The tab's
 * Assumptions block states it per run.
 */
// JSON values only: the files' shape is stated here, never derived from the import (AGENTS.md, Types from JSON).
type EpWeightsFile = { weights: Record<string, number>; pseudoWeights?: Record<string, number> };

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
	// P1_SV_EP_PRESET, which has P1_BM_EP_PRESET's numbers at fork b603564ee.
	'hunter-sv': hunterSvEpWeights as EpWeightsFile,
	// P3_ARMS_EP_PRESET ('P3, P4 & P5 - Arms'), not P1_ARMS_EP_PRESET: upstream's
	// own Arms builds for phases 3-5 use it (specs/warrior/dps/presets.ts), and the
	// page opens at phase 3 (CURRENT_PHASE), the phase the tab ranks by default.
	// The disclosure below says when a run ranks another phase.
	'warrior-arms': warriorArmsEpWeights as EpWeightsFile,
};

/**
 * The phase each spec's bundled EP weights was written for.
 *
 * `undefined` means the file records no phase at all — elemental ships a
 * single preset labelled "Default" — which still gets disclosed, as
 * "unphased default". Saying nothing because a file has no phase number
 * would be the same silent degradation the disclosure exists to prevent.
 *
 * The phases come from `data/presets/ep-weights-by-phase.json`, except ret
 * and feral (from the outer repo's docs/fork-provenance/data.md) and the two
 * talent variants (from the upstream preset names `P1_SV_EP_PRESET` and
 * `P3_ARMS_EP_PRESET`).
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
 * The EP-weights disclosure for a run that took `set`, or `undefined` when
 * the weights were written for exactly the phase being ranked.
 *
 * EP drives only the candidate prefilter and the gem fill — every ranking
 * number comes from the sim — so a mismatch degrades the shortlist's ordering
 * rather than falsifying a DPS figure. That makes it disclosable rather than
 * blocking, but it is not nothing, and it must not be silent.
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
 * The phase the pool's BiS tags speak for, or `undefined` when no preset set
 * is a BiS set at or below `maxPhase`. Earlier than `maxPhase` where the
 * spec's presets stop short of it, so the tags mean "BiS as of the latest
 * set" and the assumptions line says so.
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

/** The EP weights of a bundled set (`epWeightsSetFor`). */
export function epWeightsFor(set: EpWeightsSet): Readonly<Record<string, number>> {
	return EP_WEIGHTS_BY_SET[set].weights;
}

/** The pseudo-stat weights of a bundled set, keyed by wowsims `PseudoStat`; 0, 1 and 2 are main-hand, off-hand and ranged weapon DPS. */
export function epPseudoWeightsFor(set: EpWeightsSet): Readonly<Record<string, number>> {
	return EP_WEIGHTS_BY_SET[set].pseudoWeights ?? {};
}
