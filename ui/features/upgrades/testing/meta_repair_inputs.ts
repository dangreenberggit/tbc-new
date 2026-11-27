/**
 * Shared inputs for the meta repair tests: a ret P3 character's worn gear, the hit
 * budget its baseline reads, and helpers that read a repair's changes off two gears.
 * Each test module that imports this also mocks `@sim/proto/database` with
 * `database_mock.ts`, since the engine reads items and gems through `Database.getSync()`.
 */

import { epWeightsFor } from '../model/data/data';
import { type GemContext, gemContext } from '../model/engine/candidate-gems';
import { capProfileFor, hitCapBudgetFrom } from '../model/engine/cap-profile';
import { gemsForPhase } from '../model/engine/gems';
import { getItem } from '../model/engine/items';
import { metaDeficit, metaStatus } from '../model/engine/meta';
import type { SocketedItem } from '../model/engine/meta-repair';
import { SIM_ORDER, type SimItemSpec } from '../model/engine/slots';
import { Stat } from '../model/engine/stats';

/** The sim's `SpellSchool` bits (`sim/core/flags.go:226-232`). */
export const SCHOOL = {
	holy: 2,
	fire: 4,
	nature: 8,
	frost: 16,
	shadow: 32,
	arcane: 64,
} as const;

/**
 * The worn gear's `meleeHitPercent_final` against level 73 with no set bonus, as the
 * sim's `/computeStats` read it.
 */
export const BASELINE_HIT_PERCENT = 6.297560509125587;

/** A pseudo-stat array whose `slot` is `percent`: 12 is `PseudoStatMeleeHitPercent`, 13 `PseudoStatSpellHitPercent`. */
export function pseudoStatsWithHit(percent: number, slot = 12): number[] {
	const out = new Array<number>(25).fill(0);
	out[slot] = percent;
	return out;
}

/** The two request fields the budget reads: the debuff and the targets. */
export function budgetRequest(faerieFire: string | number | undefined, levels: readonly number[] = [73]) {
	return {
		raid: { debuffs: faerieFire === undefined ? {} : { faerieFire } },
		encounter: { targets: levels.map(level => ({ level })) },
	};
}

/**
 * A ret P3 character's worn gear in SIM_ORDER, recorded from the tab: Relentless
 * Earthstorm Diamond in the head, Bold Living Rubies elsewhere, 52 gear hit rating.
 */
const RET_P3_WORN: ReadonlyArray<{ id?: number; enchant?: number; gems?: readonly number[] }> = [
	{ id: 32461, enchant: 3003, gems: [32409, 30546] },
	{ id: 30022 },
	{ id: 30055, enchant: 2986, gems: [24027] },
	{ id: 30098, enchant: 368 },
	{ id: 30129, enchant: 2661, gems: [24027, 30584, 28363] },
	{ id: 28795, enchant: 2647, gems: [31118, 28362] },
	{ id: 29947, enchant: 684 },
	{ id: 30106, gems: [24027, 24027] },
	{ id: 30257, enchant: 3012 },
	{ id: 30104, enchant: 2657, gems: [24027, 24027] },
	{ id: 30061 },
	{ id: 30834 },
	{ id: 29383 },
	{ id: 28830 },
	{ id: 28430, enchant: 2673 },
	{},
	{ id: 27484 },
];

/** A fresh copy of the ret P3 worn gear as the engine's equipment. */
export function retP3Worn(): SimItemSpec[] {
	return RET_P3_WORN.map(it => ({
		...(it.id ? { id: it.id } : {}),
		...(it.enchant ? { enchant: it.enchant } : {}),
		gems: [...(it.gems ?? [])],
	}));
}

/** ret's P2 EP weights, which the tab ships. */
export const retWeights = epWeightsFor('ret');

export const HEAD = SIM_ORDER.indexOf('head');
export const SHOULDER = SIM_ORDER.indexOf('shoulder');
export const CHEST = SIM_ORDER.indexOf('chest');
export const WRIST = SIM_ORDER.indexOf('wrist');
export const HANDS = SIM_ORDER.indexOf('hands');

export const BOLD = 24027; // Bold Living Ruby, 8 Str
export const RIGID = 24051; // Rigid Dawnstone, 8 Hit
export const INSCRIBED = 24058; // Inscribed Noble Topaz, 4 Str 4 Crit
export const NIGHTSEYE = 24054; // Sovereign Nightseye, purple

export const RAGESTEEL_SHOULDERS = 33173;
export const RAGESTEEL_BREASTPLATE = 23522;

/** The 4 chest candidates whose gear is over the hit cap, with the sim's gear hit reading. */
export const CAPPED_CHESTS = [
	{ itemId: 32365, asBuilt: 75 }, // Heartshatter Breastplate
	{ itemId: 30102, asBuilt: 75 }, // Krakken-Heart Breastplate
	{ itemId: 28601, asBuilt: 67 }, // Chestguard of the Conniver
	{ itemId: 30896, asBuilt: 79 }, // Glory of the Defender
] as const;

/** The 19 other chest candidates, each 45 gear hit rating as built. */
export const UNCAPPED_CHESTS = [
	30907, 32334, 23522, 28599, 30913, 32592, 32327, 30075, 30887, 30899, 32340, 30904, 28602, 28578, 28662, 28735, 29921, 28600, 30065,
] as const;

/** The meta's status and deficit on a socketed list whose head is index 0. */
export function metaOf(items: readonly SocketedItem[]) {
	const head = getItem(items[0]?.itemId ?? 0);
	const status = metaStatus(
		head?.sockets ?? [],
		items.flatMap(it => it.gems.filter(g => g > 0)),
	);
	const deficit = status.kind === 'inactive' ? metaDeficit(status.metaId, status.counts) : 0;
	return { status, deficit };
}

export const socketedOf = (equipment: readonly SimItemSpec[]): SocketedItem[] => equipment.map(spec => ({ itemId: spec.id ?? 0, gems: [...spec.gems] }));

/** The sockets whose gem differs between two gears, outside `swappedSlot`, as `[itemId, socket, from, to]`. */
export function changesBetween(before: readonly SimItemSpec[], after: readonly SimItemSpec[], swappedSlot: number): Array<[number, number, number, number]> {
	const out: Array<[number, number, number, number]> = [];
	for (let i = 0; i < before.length; i++) {
		if (i === swappedSlot) continue;
		const a = before[i]!.gems;
		const b = after[i]!.gems;
		for (let s = 0; s < Math.max(a.length, b.length); s++) {
			if ((a[s] ?? 0) !== (b[s] ?? 0)) {
				out.push([after[i]!.id ?? 0, s, a[s] ?? 0, b[s] ?? 0]);
			}
		}
	}
	return out;
}

/** The (from, to) pairs of a change list, sorted, for multiset equality. */
export const pairsOf = (changes: ReadonlyArray<readonly number[]>) => changes.map(c => `${c[2]}->${c[3]}`).sort();

export const holdsGem = (equipment: readonly SimItemSpec[], gemId: number) => equipment.some(spec => spec.gems.includes(gemId));

/** The worn gear and ret's P3 gem context with no hit budget. */
export function retInputs() {
	const equipment = retP3Worn();
	const gems = gemContext(gemsForPhase(3), retWeights, 'ret');
	return { equipment, gems };
}

/** `retInputs` plus `capped`: the gem context with the worn gear's budget, as `rankUpgrades` sets it. */
export function retCapped() {
	const inputs = retInputs();
	const budget = hitCapBudgetFrom(capProfileFor('ret'), budgetRequest('TristateEffectImproved'), pseudoStatsWithHit(BASELINE_HIT_PERCENT))!;
	const capped: GemContext = {
		...inputs.gems,
		repairHitBudget: {
			stat: Stat.StatMeleeHitRating,
			baselineRemaining: budget.remaining,
			baselineGearHit: 52,
		},
	};
	return { ...inputs, capped };
}
