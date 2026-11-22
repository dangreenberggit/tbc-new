/**
 * `applyNetCorrection` gives each set bonus its `bonusDpsNet`: `bonusDps` corrected for the
 * worn bonuses its added pieces lose. `countMembersBreaking` counts the pieces that lose one
 * by their own swap, a term of that correction. No sims.
 */

import { getItem } from './items';
import type { SetBonusValue } from './rank-types';
import { bonusKey, type BrokenSetBonus, brokenSetBonuses, type CountsAsBreak, type InflationTerm, netInflation } from './set-value';
import type { SimItemSpec } from './slots';

/**
 * Correct `bonusDps` for the worn bonuses its added pieces lose, using their
 * measured values: `bonusDpsNet = bonusDps − netInflation(terms)`. Each
 * entry's own `breaks` keep this right when the 2pc and 4pc pick different
 * slots. The terms come from the union of this entry's, the 2pc entry's and every
 * added piece's own losses. While the 2pc's pieces are a prefix of the
 * 4pc's, that union is this entry's own `breaks`; the union keeps the
 * formula whole if `selectAddedPieces` changes.
 */
export function applyNetCorrection(
	results: readonly SetBonusValue[],
	equipment: readonly SimItemSpec[],
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	countsAsBreak: CountsAsBreak,
	brokenDpsByKey: ReadonlyMap<string, number | undefined>,
): void {
	const memberOwnBreaks = (bonus: SetBonusValue): BrokenSetBonus[] =>
		bonus.packageItemIds.flatMap(itemId => {
			const slotIndex = firstSlotIndexByItemId.get(itemId);
			const memberSetId = getItem(itemId)?.setId;
			if (slotIndex === undefined || memberSetId == null) return [];
			return brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		});
	for (const b of results) {
		if (b.bonusDps === undefined) continue;
		// A worn-1 4pc whose 2pc the pair sim did not measure is still short by
		// the 2pc once per piece after the first. Crediting it would rank rows on
		// a wrong figure, so the net stays unset and the row shows as not counted.
		if (b.selfConfound !== undefined && b.selfConfound.dps === undefined) {
			continue;
		}
		// The 2pc's terms apply only when the 4pc subtracted a measured 2pc value.
		const twoPiece =
			b.threshold === 4
				? results.find(r => r.setId === b.setId && r.threshold === 2 && r.unmeasured === undefined && r.bonusDps !== undefined)
				: undefined;
		const breaksToCorrect = new Map<string, BrokenSetBonus>();
		for (const brk of [...(b.breaks ?? []), ...(twoPiece?.breaks ?? []), ...memberOwnBreaks(b), ...(twoPiece ? memberOwnBreaks(twoPiece) : [])]) {
			breaksToCorrect.set(bonusKey(brk), brk);
		}
		const brokenByAllPieces = new Set((b.breaks ?? []).map(bonusKey));
		const brokenByAllTwoPcPieces = new Set((twoPiece?.breaks ?? []).map(bonusKey));
		const terms: InflationTerm[] = [];
		let allMeasured = true;
		for (const [key, brk] of breaksToCorrect) {
			const brokenBonusDps = brokenDpsByKey.get(key);
			if (brokenBonusDps === undefined) {
				allMeasured = false;
				break;
			}
			terms.push({
				piecesBreakingAlone: countMembersBreaking(b, brk, equipment, firstSlotIndexByItemId, countsAsBreak),
				twoPcPiecesBreakingAlone: twoPiece ? countMembersBreaking(twoPiece, brk, equipment, firstSlotIndexByItemId, countsAsBreak) : 0,
				allPiecesBreak: brokenByAllPieces.has(key) ? 1 : 0,
				allTwoPcPiecesBreak: brokenByAllTwoPcPieces.has(key) ? 1 : 0,
				brokenBonusDps,
			});
		}
		if (allMeasured) b.bonusDpsNet = b.bonusDps - netInflation(terms);
	}
}

/**
 * How many of `bonus`'s added pieces lose the worn bonus `target` by their own
 * swap, for `netInflation`.
 */
export function countMembersBreaking(
	bonus: SetBonusValue,
	target: Pick<BrokenSetBonus, 'setId' | 'threshold'>,
	equipment: readonly SimItemSpec[],
	firstSlotIndexByItemId: ReadonlyMap<number, number>,
	countsAsBreak: CountsAsBreak,
): number {
	let k = 0;
	for (const itemId of bonus.packageItemIds) {
		const slotIndex = firstSlotIndexByItemId.get(itemId);
		if (slotIndex === undefined) continue;
		const memberSetId = getItem(itemId)?.setId;
		if (memberSetId == null) continue;
		const breaks = brokenSetBonuses(equipment, [{ itemId, slotIndex }], memberSetId, countsAsBreak);
		if (breaks.some(brk => brk.setId === target.setId && brk.threshold === target.threshold)) {
			k += 1;
		}
	}
	return k;
}
