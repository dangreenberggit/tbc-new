/**
 * `RankedItem.setContext`: for each row, the set bonuses it reaches, keeps or breaks, and the
 * pieces still needed. `applySetContext` writes it onto the rows; the helpers are pure.
 */

import { getItem } from './items';
import type { AddedPiecesContext, CrossingCheck, RankedItem, SetBonusValue, SetContext } from './rank-types';
import {
	bonusKey,
	type BrokenSetBonus,
	brokenSetBonuses,
	type CountsAsBreak,
	isBonusImplemented,
	nextImplementedThreshold,
	type OwnDelta,
	type PlacedItem,
	SET_THRESHOLDS,
	setCounts,
	setNameOf,
	type SetThreshold,
} from './set-value';
import { brokenBonusWithDps } from './set-worn-ladder';
import type { SimItemSpec } from './slots';

/** The highest-count measured entry with added pieces, for `commitBreaks`. */
function topMeasuredBonus(bonusesForSet: readonly SetBonusValue[]): SetBonusValue | undefined {
	// A `belowNoise` entry lists added pieces but never simmed them.
	return [...bonusesForSet]
		.filter(b => b.unmeasured === undefined && !b.belowNoise && b.packageItemIds.length > 0)
		.sort((a, b) => b.threshold - a.threshold)[0];
}

/**
 * The worn bonuses lost by the top entry's added pieces with `itemId` in its
 * own slot (the entry's piece in that slot, if any, is dropped): a row's
 * `commitBreaks` before its own losses are taken out.
 */
function topBonusBreaksWithRow(
	itemId: number,
	setId: number,
	slotIndex: number,
	topBonus: SetBonusValue,
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	equipment: readonly SimItemSpec[],
	countsAsBreak: CountsAsBreak,
): BrokenSetBonus[] {
	const substituted: PlacedItem[] = topBonus.packageItemIds
		.map(pieceItemId => ({
			itemId: pieceItemId,
			slotIndex: firstSlotIndexByItemId.get(pieceItemId),
		}))
		.filter((p): p is PlacedItem => p.slotIndex !== undefined && p.slotIndex !== slotIndex);
	substituted.push({ itemId, slotIndex });
	return brokenSetBonuses(equipment, substituted, setId, countsAsBreak);
}

/**
 * The pieces a player adds to reach `bonus`'s threshold with this candidate as
 * one of them: all of `bonus`'s added pieces if the candidate is one, else the
 * candidate plus the best of them outside its slot, one fewer than `bonus`
 * adds, ranked as `selectAddedPieces` ranks them (own gain, then lowest id).
 */
function pathToThreshold(
	itemId: number,
	slotIndex: number,
	bonus: SetBonusValue,
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>,
): PlacedItem[] {
	const members = bonus.packageItemIds
		.map(pieceItemId => ({
			itemId: pieceItemId,
			slotIndex: firstSlotIndexByItemId.get(pieceItemId),
		}))
		.filter((p): p is PlacedItem => p.slotIndex !== undefined);
	if (bonus.packageItemIds.includes(itemId)) return members;
	const deltaOf = (id: number) => ownDeltasByItemId.get(id)?.deltaDps ?? -Infinity;
	const rest = members
		.filter(p => p.slotIndex !== slotIndex)
		.sort((a, b) => (deltaOf(b.itemId) !== deltaOf(a.itemId) ? deltaOf(b.itemId) - deltaOf(a.itemId) : a.itemId - b.itemId))
		.slice(0, bonus.packageItemIds.length - 1);
	return [...rest, { itemId, slotIndex }];
}

/**
 * The smallest entry count above `after` whose bonus was above noise on its
 * own gear, or null. An entry has `sameGearDps` without `belowNoise` exactly
 * when it was.
 */
function nextClearedThreshold(bonusesForSet: readonly SetBonusValue[], after: number): SetThreshold | null {
	const counts = bonusesForSet.filter(b => b.threshold > after && b.sameGearDps !== undefined && !b.belowNoise).map(b => b.threshold);
	return counts.length > 0 ? Math.min(...counts) : null;
}

export function bonusesWithItem(itemId: number, bonusesForSet: readonly SetBonusValue[]): AddedPiecesContext[] | undefined {
	// A `belowNoise` entry's pieces were never simmed, so its `packageDeltaDps`
	// of 0 is not a measurement.
	const measured = bonusesForSet.filter(b => b.unmeasured === undefined && !b.belowNoise);
	if (!measured.some(b => b.packageItemIds.includes(itemId))) {
		return undefined;
	}
	return measured
		.slice()
		.sort((a, b) => a.threshold - b.threshold)
		.map(b => ({
			threshold: b.threshold,
			deltaDps: b.packageDeltaDps,
			itemIds: b.packageItemIds,
			piecesNeeded: b.packageItemIds.length,
		}));
}

/** What `applySetContext` reads: the rows, the set phase's entries and its maps. */
export type SetContextArgs = {
	ranked: RankedItem[];
	setBonuses: readonly SetBonusValue[];
	equipment: readonly SimItemSpec[];
	/** `brokenBonusDpsByKey` of the set phase's `brokenSetValues`. */
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>;
	firstSlotIndexByItemId: ReadonlyMap<number, number>;
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	/** Absent without `measureSetBonuses`: the `isBonusImplemented` table decides. */
	countsAsBreak?: CountsAsBreak;
	/**
	 * Present exactly with `measureSetBonuses`: the `crossingChecks`, so the
	 * reached and next counts read measurements instead of the
	 * `isBonusImplemented` table, and every entry above the swap's count
	 * becomes a future bonus.
	 */
	measured?: { crossingChecks: readonly CrossingCheck[] };
	setIdsNotValued: readonly number[];
};

/** The run-wide inputs every row's helpers read, with `countsAsBreak` resolved. */
type SetContextRun = {
	equipment: readonly SimItemSpec[];
	brokenBonusDpsByKey: ReadonlyMap<string, number | undefined>;
	firstSlotIndexByItemId: ReadonlyMap<number, number>;
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta>;
	countsAsBreak: CountsAsBreak;
	measured?: { crossingChecks: readonly CrossingCheck[] };
	rankedById: ReadonlyMap<number, RankedItem>;
};

/** A row's piece counts before and after its swap, and the set counts around them. */
type ThresholdStatus = {
	piecesWornBefore: number;
	piecesAfterSwap: number;
	/** The next bonus count above the worn count, before the swap. */
	nextThresholdBeforeSwap: SetThreshold | null;
	crossesThreshold: boolean;
	nextThreshold: SetThreshold | null;
};

/** One set row, as its helpers see it. `slotIndex` is undefined when the item has no slot in this run. */
type SetRow = ThresholdStatus & {
	itemId: number;
	setId: number;
	bonusesForSet: readonly SetBonusValue[];
	slotIndex: number | undefined;
};

type FutureBonuses = NonNullable<SetContext['futureBonuses']>;

/**
 * Writes `setContext` onto every row whose item is in a set with entries (or
 * in `setIdsNotValued`). Runs before `measureBonusGear`, which edits the
 * future bonuses in place.
 */
export function applySetContext(args: SetContextArgs): void {
	const { ranked, setBonuses, equipment, measured, setIdsNotValued } = args;
	const wornCounts = setCounts(equipment);
	const bonusesBySet = new Map<number, SetBonusValue[]>();
	for (const b of setBonuses) {
		const list = bonusesBySet.get(b.setId) ?? [];
		list.push(b);
		bonusesBySet.set(b.setId, list);
	}
	for (const setId of setIdsNotValued) {
		if (!bonusesBySet.has(setId)) bonusesBySet.set(setId, []);
	}
	const run: SetContextRun = {
		equipment,
		brokenBonusDpsByKey: args.brokenBonusDpsByKey,
		firstSlotIndexByItemId: args.firstSlotIndexByItemId,
		ownDeltasByItemId: args.ownDeltasByItemId,
		countsAsBreak: args.countsAsBreak ?? isBonusImplemented,
		measured,
		rankedById: new Map(ranked.map(r => [r.itemId, r])),
	};

	for (const item of ranked) {
		const setId = getItem(item.itemId)?.setId;
		if (setId == null) continue;
		const bonusesForSet = bonusesBySet.get(setId);
		if (!bonusesForSet) continue;

		const status = thresholdStatus(item, setId, bonusesForSet, wornCounts.get(setId) ?? 0, measured);
		const row: SetRow = { itemId: item.itemId, setId, bonusesForSet, slotIndex: run.firstSlotIndexByItemId.get(item.itemId), ...status };
		const singleBreaks = ownBreaksFor(run, row);
		const ownBreakKeys = new Set((singleBreaks ?? []).map(bonusKey));
		const futureBonuses = futureBonusesFor(run, row, ownBreakKeys);
		const bonuses = bonusesWithItem(item.itemId, bonusesForSet);
		item.setContext = {
			setId,
			setName: bonusesForSet[0]?.setName ?? setNameOf(equipment, setId, [item.itemId]),
			piecesWornBefore: status.piecesWornBefore,
			piecesAfterSwap: status.piecesAfterSwap,
			nextThreshold: status.nextThreshold,
			crossesThreshold: status.crossesThreshold,
			...(measured ? { usesBonusGear: true as const } : {}),
			...(singleBreaks ? { singleBreaks } : {}),
			...(futureBonuses.length > 0 ? { futureBonuses } : {}),
			...commitFieldsFor(run, row, ownBreakKeys),
			...(bonuses ? { packages: bonuses } : {}),
		};
	}
}

/** A row's piece counts and whether its swap reaches the next bonus. */
function thresholdStatus(
	item: RankedItem,
	setId: number,
	bonusesForSet: readonly SetBonusValue[],
	piecesWornBefore: number,
	measured: SetContextRun['measured'],
): ThresholdStatus {
	const piecesAfterSwap = item.owned ? piecesWornBefore : piecesWornBefore + 1;
	// With `measureSetBonuses`, one more piece reaches a bonus only when
	// that count's `crossingChecks` entry cleared, and the next bonus is the
	// next count above noise. No table is read.
	const crossingCleared = measured?.crossingChecks.some(g => g.setId === setId && g.count === piecesWornBefore + 1 && g.cleared) ?? false;
	const nextThresholdBeforeSwap = measured
		? crossingCleared
			? piecesWornBefore + 1
			: nextClearedThreshold(bonusesForSet, piecesWornBefore)
		: nextImplementedThreshold(setId, piecesWornBefore);
	const crossesThreshold = measured
		? !item.owned && piecesAfterSwap === piecesWornBefore + 1 && crossingCleared
		: nextThresholdBeforeSwap !== null && piecesAfterSwap >= nextThresholdBeforeSwap;
	const nextThreshold = measured ? nextClearedThreshold(bonusesForSet, piecesAfterSwap) : nextImplementedThreshold(setId, piecesAfterSwap);
	return { piecesWornBefore, piecesAfterSwap, nextThresholdBeforeSwap, crossesThreshold, nextThreshold };
}

/** A row's `singleBreaks`, or undefined when it loses none or has no slot. */
function ownBreaksFor(run: SetContextRun, row: SetRow): SetContext['singleBreaks'] {
	// singleBreaks: worn bonuses this piece loses by itself, already inside
	// deltaDps; dps is their measured value when there is one.
	if (row.slotIndex === undefined) return undefined;
	const ownBreaks = brokenSetBonuses(run.equipment, [{ itemId: row.itemId, slotIndex: row.slotIndex }], row.setId, run.countsAsBreak);
	return ownBreaks.length > 0 ? ownBreaks.map(brk => brokenBonusWithDps(brk, run.brokenBonusDpsByKey)) : undefined;
}

/**
 * A path piece's swap gain, read before replication rewrites the top
 * rows' `deltaDps`, so a row among measured added pieces sums to their
 * gain. The worn bonuses it loses alone are added back because the path
 * charges each loss once; the 2pc it reaches alone at worn 1 is taken out
 * because the row's own gain already holds it. Undefined when any input
 * was unmeasured.
 */
function pathPieceGain(run: SetContextRun, row: SetRow, p: PlacedItem): number | undefined {
	const ownDelta = run.ownDeltasByItemId.get(p.itemId)?.deltaDps;
	if (ownDelta === undefined) return undefined;
	let gain = ownDelta;
	for (const brk of brokenSetBonuses(run.equipment, [p], row.setId, run.countsAsBreak)) {
		const dps = run.brokenBonusDpsByKey.get(bonusKey(brk));
		if (dps === undefined) return undefined;
		gain += dps;
	}
	const countAfterPieceSwap = run.rankedById.get(p.itemId)?.owned ? row.piecesWornBefore : row.piecesWornBefore + 1;
	if (row.nextThresholdBeforeSwap !== null && countAfterPieceSwap >= row.nextThresholdBeforeSwap) {
		const crossed = row.bonusesForSet.find(b => b.selfConfound?.threshold === row.nextThresholdBeforeSwap)?.selfConfound?.dps;
		if (crossed === undefined) return undefined;
		gain -= crossed;
	}
	return gain;
}

/** A row's `futureBonuses`, empty when there are none. */
function futureBonusesFor(run: SetContextRun, row: SetRow, ownBreakKeys: ReadonlySet<string>): FutureBonuses {
	const { itemId, setId, bonusesForSet, slotIndex, piecesWornBefore, piecesAfterSwap } = row;
	// futureBonuses: every implemented threshold above the post-swap count,
	// with its net value (dps absent when unmeasured). Only for a swap that
	// adds a set piece: a worn row's swap changes nothing, so a future bonus
	// would rank "keep what you wear" on value the swap cannot bring.
	const advancesPieceCount = piecesAfterSwap > piecesWornBefore;
	// The view never adds a `belowNoise` bonus (`canBeCredited`), but it is
	// listed so the row can say the count was tried.
	const futureThresholds = run.measured
		? bonusesForSet
				.filter(b => advancesPieceCount && b.threshold > piecesAfterSwap && (b.packageItemIds.length > 0 || b.belowNoise === true))
				.map(b => b.threshold)
				.sort((a, b) => a - b)
		: [...SET_THRESHOLDS].filter(t => advancesPieceCount && t > piecesAfterSwap && isBonusImplemented(setId, t));
	return futureThresholds.map(t => {
		const bonus = bonusesForSet.find(b => b.threshold === t);
		const net = bonus?.bonusDpsNet;
		// No path through a `belowNoise` entry: its pieces were never simmed.
		const path =
			bonus && bonus.unmeasured === undefined && !bonus.belowNoise && bonus.packageItemIds.length > 0 && slotIndex !== undefined
				? pathToThreshold(itemId, slotIndex, bonus, run.firstSlotIndexByItemId, run.ownDeltasByItemId)
				: undefined;
		// The worn bonuses this path loses beyond the row's own loss. Ones a
		// lower future bonus already lists stay; the view charges each once.
		const pathBreaks = path ? brokenSetBonuses(run.equipment, path, setId, run.countsAsBreak).filter(brk => !ownBreakKeys.has(bonusKey(brk))) : [];
		// The path's other pieces. Ones a lower future bonus already lists stay;
		// the view counts each once.
		const pieces = path
			?.filter(p => p.itemId !== itemId)
			.map(p => {
				const dps = pathPieceGain(run, row, p);
				return {
					itemId: p.itemId,
					name: run.rankedById.get(p.itemId)?.name ?? String(p.itemId),
					...(dps !== undefined ? { dps } : {}),
				};
			});
		// Pieces the player still needs from their current worn count to
		// activate this threshold, counting this candidate as one of them (at
		// worn 1 the 4pc needs 3 more).
		return {
			threshold: t,
			piecesNeeded: t - piecesWornBefore,
			...(net !== undefined ? { dps: net } : {}),
			...(bonus?.sameGearDps !== undefined && bonus.sameGearSe !== undefined ? { sameGearDps: bonus.sameGearDps, sameGearSe: bonus.sameGearSe } : {}),
			...(bonus?.belowNoise ? { belowNoise: true as const } : {}),
			...(pathBreaks.length > 0 ? { breaks: pathBreaks.map(brk => brokenBonusWithDps(brk, run.brokenBonusDpsByKey)) } : {}),
			...(pieces ? { pieces } : {}),
		};
	});
}

/** A row's `commitBreaks` and `commitPackageDeltaDps`, in that key order; empty without a top entry or a slot. */
function commitFieldsFor(run: SetContextRun, row: SetRow, ownBreakKeys: ReadonlySet<string>): Pick<SetContext, 'commitBreaks' | 'commitPackageDeltaDps'> {
	// commitBreaks: the worn bonuses lost by the top entry's added pieces with
	// this item in its slot, beyond the row's own loss. commitPackageDeltaDps:
	// those pieces' sim gain, shown only.
	const topBonus = topMeasuredBonus(row.bonusesForSet);
	if (!topBonus || row.slotIndex === undefined) return {};
	const topBonusBreaks = topBonusBreaksWithRow(row.itemId, row.setId, row.slotIndex, topBonus, run.firstSlotIndexByItemId, run.equipment, run.countsAsBreak);
	const topBonusBreaksBeyondRow = topBonusBreaks.filter(brk => !ownBreakKeys.has(bonusKey(brk)));
	return {
		...(topBonusBreaksBeyondRow.length > 0 ? { commitBreaks: topBonusBreaksBeyondRow.map(brk => brokenBonusWithDps(brk, run.brokenBonusDpsByKey)) } : {}),
		commitPackageDeltaDps: topBonus.packageDeltaDps,
	};
}
