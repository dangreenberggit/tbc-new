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
import mageEpWeights from './mage-fallback.ep-weights.json';
import retEpWeights from './ret-p2.ep-weights.json';
import rogueEpWeights from './rogue-fallback.ep-weights.json';
import shadowEpWeights from './shadow-fallback.ep-weights.json';
import warlockEpWeights from './warlock-fallback.ep-weights.json';
import warriorEpWeights from './warrior-fallback.ep-weights.json';

/**
 * One EP-weights set per spec.
 *
 * The nine specs added by the all-DPS-specs pass each bundle their
 * `fallback` file — the entry `data/presets/ep-weights-by-phase.json` names
 * for a spec below its lowest `byPhase` key. A spec whose weights were
 * written for an earlier phase than the one being ranked is a real,
 * disclosed degradation, not a bug: EP drives only the candidate prefilter
 * and the gem fill, and every ranking number comes from the sim. The tab's
 * Assumptions block states it per run.
 */
const EP_WEIGHTS_BY_SPEC: Record<SpecId, Readonly<Record<string, number>>> = {
	ret: (retEpWeights as { weights: Record<string, number> }).weights,
	feral: (feralEpWeights as { weights: Record<string, number> }).weights,
	balance: (balanceEpWeights as { weights: Record<string, number> }).weights,
	hunter: (hunterEpWeights as { weights: Record<string, number> }).weights,
	mage: (mageEpWeights as { weights: Record<string, number> }).weights,
	shadow: (shadowEpWeights as { weights: Record<string, number> }).weights,
	rogue: (rogueEpWeights as { weights: Record<string, number> }).weights,
	ele: (eleEpWeights as { weights: Record<string, number> }).weights,
	enh: (enhEpWeights as { weights: Record<string, number> }).weights,
	warlock: (warlockEpWeights as { weights: Record<string, number> }).weights,
	warrior: (warriorEpWeights as { weights: Record<string, number> }).weights,
};

/**
 * The phase each spec's bundled EP weights was written for.
 *
 * `undefined` means the file records no phase at all — elemental ships a
 * single preset labelled "Default" — which still gets disclosed, as
 * "unphased default". Saying nothing because a file has no phase number
 * would be the same silent degradation the disclosure exists to prevent.
 *
 * These are the phases named by `data/presets/ep-weights-by-phase.json` for
 * each bundled file. Ret and feral keep the values the outer repo's
 * docs/fork-provenance/data.md already records.
 */
const EP_WEIGHTS_PHASE_BY_SPEC: Record<SpecId, number | undefined> = {
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
};

/**
 * The EP-weights disclosure for a run, or `undefined` when the weights were
 * written for exactly the phase being ranked.
 *
 * EP drives only the candidate prefilter and the gem fill — every ranking
 * number comes from the sim — so a mismatch degrades the shortlist's ordering
 * rather than falsifying a DPS figure. That makes it disclosable rather than
 * blocking, but it is not nothing, and it must not be silent.
 */
export function epWeightsDisclosureFor(spec: SpecId, maxPhase: ContentPhase): { from: string; requested: string } | undefined {
	const phase = EP_WEIGHTS_PHASE_BY_SPEC[spec];
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

/** The page's candidate pool at `maxPhase`; empty until the sim's database has loaded. */
export function poolFor(host: PagePoolHost, maxPhase: ContentPhase): readonly PoolEntry[] {
	if (!host.sim.db) return [];
	return buildPool(host, host.individualConfig.presets.gear.map(presetSetOf), maxPhase);
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

export function epWeightsFor(spec: SpecId): Readonly<Record<string, number>> {
	return EP_WEIGHTS_BY_SPEC[spec];
}
