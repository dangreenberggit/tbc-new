/**
 * `RankedItem.setContext`: for each row, the set bonuses it reaches, keeps or breaks, and the
 * pieces still needed. Pure.
 */

import { getItem } from './items';
import type { AddedPiecesContext, BrokenSetValue, CrossingCheck, RankedItem, SetBonusValue, SetContext } from './rank-types';
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

export function applySetContext(
	ranked: RankedItem[],
	setBonuses: readonly SetBonusValue[],
	equipment: readonly SimItemSpec[],
	brokenSetValues: readonly BrokenSetValue[] = [],
	firstSlotIndexByItemId: ReadonlyMap<number, number> = new Map(),
	ownDeltasByItemId: ReadonlyMap<number, OwnDelta> = new Map(),
	countsAsBreak: CountsAsBreak = isBonusImplemented,
	/**
	 * Present exactly with `measureSetBonuses`: the `crossingChecks`, so the
	 * reached and next counts read measurements instead of the
	 * `isBonusImplemented` table, and every entry above the swap's count
	 * becomes a future bonus.
	 */
	measured?: { crossingChecks: readonly CrossingCheck[] },
	setIdsNotValued: readonly number[] = [],
): void {
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
	const brokenBonusDpsByKey = new Map<string, number | undefined>();
	for (const v of brokenSetValues) brokenBonusDpsByKey.set(bonusKey(v), v.dps);
	const brokenBonusDps = (brk: BrokenSetBonus): number | undefined => brokenBonusDpsByKey.get(bonusKey(brk));
	const rankedById = new Map(ranked.map(r => [r.itemId, r]));

	for (const item of ranked) {
		const setId = getItem(item.itemId)?.setId;
		if (setId == null) continue;
		const bonusesForSet = bonusesBySet.get(setId);
		if (!bonusesForSet) continue;

		const piecesWornBefore = wornCounts.get(setId) ?? 0;
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

		const setContext: SetContext = {
			setId,
			setName: bonusesForSet[0]?.setName ?? setNameOf(equipment, setId, [item.itemId]),
			piecesWornBefore,
			piecesAfterSwap,
			nextThreshold,
			crossesThreshold,
			...(measured ? { usesBonusGear: true as const } : {}),
		};

		const slotIndex = firstSlotIndexByItemId.get(item.itemId);

		// singleBreaks: worn bonuses this piece loses by itself, already inside
		// deltaDps; dps is their measured value when there is one.
		if (slotIndex !== undefined) {
			const ownBreaks = brokenSetBonuses(equipment, [{ itemId: item.itemId, slotIndex }], setId, countsAsBreak);
			if (ownBreaks.length > 0) {
				setContext.singleBreaks = ownBreaks.map(brk => {
					const dps = brokenBonusDps(brk);
					return {
						setId: brk.setId,
						setName: brk.setName,
						threshold: brk.threshold,
						...(dps !== undefined ? { dps } : {}),
					};
				});
			}
		}

		// futureBonuses: every implemented threshold above the post-swap count,
		// with its net value (dps absent when unmeasured). Only for a swap that
		// adds a set piece: a worn row's swap changes nothing, so a future bonus
		// would rank "keep what you wear" on value the swap cannot bring.
		const advancesPieceCount = piecesAfterSwap > piecesWornBefore;
		// The view never adds a `belowNoise` bonus (`canBeCredited`), but it is
		// listed so the row can say the count was tried.
		const futureThresholds = measured
			? bonusesForSet
					.filter(b => advancesPieceCount && b.threshold > piecesAfterSwap && (b.packageItemIds.length > 0 || b.belowNoise === true))
					.map(b => b.threshold)
					.sort((a, b) => a - b)
			: [...SET_THRESHOLDS].filter(t => advancesPieceCount && t > piecesAfterSwap && isBonusImplemented(setId, t));
		const ownBreakKeys = new Set((setContext.singleBreaks ?? []).map(bonusKey));
		const withDps = (brk: BrokenSetBonus) => {
			const dps = brokenBonusDps(brk);
			return {
				setId: brk.setId,
				setName: brk.setName,
				threshold: brk.threshold,
				...(dps !== undefined ? { dps } : {}),
			};
		};
		// A path piece's swap gain, read before replication rewrites the top
		// rows' `deltaDps`, so a row among measured added pieces sums to their
		// gain. The worn bonuses it loses alone are added back because the path
		// charges each loss once; the 2pc it reaches alone at worn 1 is taken out
		// because the row's own gain already holds it. Undefined when any input
		// was unmeasured.
		const pathPieceGain = (p: PlacedItem): number | undefined => {
			const ownDelta = ownDeltasByItemId.get(p.itemId)?.deltaDps;
			if (ownDelta === undefined) return undefined;
			let gain = ownDelta;
			for (const brk of brokenSetBonuses(equipment, [p], setId, countsAsBreak)) {
				const dps = brokenBonusDps(brk);
				if (dps === undefined) return undefined;
				gain += dps;
			}
			const countAfterPieceSwap = rankedById.get(p.itemId)?.owned ? piecesWornBefore : piecesWornBefore + 1;
			if (nextThresholdBeforeSwap !== null && countAfterPieceSwap >= nextThresholdBeforeSwap) {
				const crossed = bonusesForSet.find(b => b.selfConfound?.threshold === nextThresholdBeforeSwap)?.selfConfound?.dps;
				if (crossed === undefined) return undefined;
				gain -= crossed;
			}
			return gain;
		};
		const futureBonuses = futureThresholds.map(t => {
			const bonus = bonusesForSet.find(b => b.threshold === t);
			const net = bonus?.bonusDpsNet;
			// No path through a `belowNoise` entry: its pieces were never simmed.
			const path =
				bonus && bonus.unmeasured === undefined && !bonus.belowNoise && bonus.packageItemIds.length > 0 && slotIndex !== undefined
					? pathToThreshold(item.itemId, slotIndex, bonus, firstSlotIndexByItemId, ownDeltasByItemId)
					: undefined;
			// The worn bonuses this path loses beyond the row's own loss. Ones a
			// lower future bonus already lists stay; the view charges each once.
			const pathBreaks = path ? brokenSetBonuses(equipment, path, setId, countsAsBreak).filter(brk => !ownBreakKeys.has(bonusKey(brk))) : [];
			// The path's other pieces. Ones a lower future bonus already lists stay;
			// the view counts each once.
			const pieces = path
				?.filter(p => p.itemId !== item.itemId)
				.map(p => {
					const dps = pathPieceGain(p);
					return {
						itemId: p.itemId,
						name: rankedById.get(p.itemId)?.name ?? String(p.itemId),
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
				...(pathBreaks.length > 0 ? { breaks: pathBreaks.map(withDps) } : {}),
				...(pieces ? { pieces } : {}),
			};
		});
		if (futureBonuses.length > 0) setContext.futureBonuses = futureBonuses;

		// commitBreaks: the worn bonuses lost by the top entry's added pieces with
		// this item in its slot, beyond the row's own loss. commitPackageDeltaDps:
		// those pieces' sim gain, shown only.
		const topBonus = topMeasuredBonus(bonusesForSet);
		if (topBonus && slotIndex !== undefined) {
			const topBonusBreaks = topBonusBreaksWithRow(item.itemId, setId, slotIndex, topBonus, firstSlotIndexByItemId, equipment, countsAsBreak);
			const topBonusBreaksBeyondRow = topBonusBreaks.filter(brk => !ownBreakKeys.has(bonusKey(brk)));
			if (topBonusBreaksBeyondRow.length > 0) {
				setContext.commitBreaks = topBonusBreaksBeyondRow.map(withDps);
			}
			setContext.commitPackageDeltaDps = topBonus.packageDeltaDps;
		}

		const bonuses = bonusesWithItem(item.itemId, bonusesForSet);
		if (bonuses) setContext.packages = bonuses;
		item.setContext = setContext;
	}
}
