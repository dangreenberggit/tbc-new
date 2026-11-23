/**
 * Picks the other pieces of a set (the partners) that a set row is simmed with to reach
 * one bonus. `closeCalls` and `pickClosest` are the only place they are picked, so the
 * rule can be swapped here alone.
 *
 * The rule, 'close-calls', ranks every combination by the 'sum-of-singles' estimate, then
 * sims those within `CLOSE_CALL_MARGIN_DPS` of the best and keeps the highest delta.
 *
 * The estimate adds up each piece's DPS change when swapped in alone, then fixes the worn
 * bonuses that sum gets wrong. A bonus several pieces each break alone is charged once per
 * piece, so the extra charges are added back. A bonus only the full swap breaks was never
 * charged, so it is taken off. It has no term for the bonus being reached, which every
 * combination reaches alike. Rules that rank by the estimate break ties to the lowest
 * sorted item ids.
 */

import { bonusKey, type BrokenSetBonus, type PlacedItem } from './set-value';

/** Written to `bonusGearSims` and each future bonus, which name the rule that chose the pieces. */
export type PartnerRule = 'close-calls';

/**
 * The rule. On eight test characters, no rule that picks without simming chose a
 * combination within noise of the best simmed combination on every row.
 */
export const PARTNER_RULE: PartnerRule = 'close-calls';

/**
 * How far below the best 'sum-of-singles' estimate a combination may be and still be simmed by
 * 'close-calls': twice the largest gap seen on the eight test characters between the
 * best estimate and the estimate of the combination the sims found best.
 */
export const CLOSE_CALL_MARGIN_DPS = 31.866872635956497;

/** One candidate piece of the row's set, at its first sim slot. */
export type PartnerPiece = {
	itemId: number;
	slotIndex: number;
	ownDeltaDps: number;
};

/**
 * The set's pieces that were simmed alone, outside the row's slot and the slots the set
 * already fills, best per slot (lower id on a tie), in slot order. Rings, trinkets and
 * one-handers are keyed to their first slot, as in `selectAddedPieces`.
 */
export function partnerPool(args: { pieces: readonly PartnerPiece[]; wornSetSlots: ReadonlySet<number>; rowSlotIndex: number }): PartnerPiece[] {
	const bestPerSlot = new Map<number, PartnerPiece>();
	for (const piece of args.pieces) {
		if (piece.slotIndex === args.rowSlotIndex) continue;
		if (args.wornSetSlots.has(piece.slotIndex)) continue;
		const current = bestPerSlot.get(piece.slotIndex);
		if (!current || piece.ownDeltaDps > current.ownDeltaDps || (piece.ownDeltaDps === current.ownDeltaDps && piece.itemId < current.itemId)) {
			bestPerSlot.set(piece.slotIndex, piece);
		}
	}
	return [...bestPerSlot.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

export type PartnerQuery = {
	row: { itemId: number; slotIndex: number; ownDeltaDps: number };
	setId: number;
	/** The piece count the bonus turns on at. */
	threshold: number;
	/** How many partner pieces reach `threshold` with the row worn. */
	needed: number;
	pool: readonly PartnerPiece[];
	/** The worn bonuses that count as lost when every listed swap is made. */
	brokenBy: (swaps: readonly PlacedItem[]) => readonly Pick<BrokenSetBonus, 'setId' | 'threshold'>[];
	/** A worn bonus's measured value; undefined when unmeasured. */
	breakDps: (setId: number, threshold: number) => number | undefined;
};

/** Every combination of `needed` pool pieces, each in slot order. */
export function partnerCombinations(query: PartnerQuery): PartnerPiece[][] {
	const out: PartnerPiece[][] = [];
	const { pool, needed } = query;
	if (needed <= 0 || needed > pool.length) return out;
	const pick = (start: number, chosen: PartnerPiece[]): void => {
		if (chosen.length === needed) {
			out.push([...chosen]);
			return;
		}
		for (let i = start; i <= pool.length - (needed - chosen.length); i++) {
			chosen.push(pool[i]!);
			pick(i + 1, chosen);
			chosen.pop();
		}
	};
	pick(0, []);
	return out;
}

/**
 * The 'sum-of-singles' estimate of one combination. Undefined when a bonus that changes the
 * estimate is unmeasured.
 * It has no term for the bonus the swaps reach: the callers' `brokenBy` leaves that set out.
 * Partner choice compares combinations that reach the same bonus, and the set screen adds
 * the set's bonuses as its pair's DPS.
 */
export function estimateCombinedDelta(query: Pick<PartnerQuery, 'row' | 'brokenBy' | 'breakDps'>, combination: readonly PartnerPiece[]): number | undefined {
	const rowSwap: PlacedItem = {
		itemId: query.row.itemId,
		slotIndex: query.row.slotIndex,
	};
	const swaps: PlacedItem[] = [rowSwap, ...combination.map(p => ({ itemId: p.itemId, slotIndex: p.slotIndex }))];
	const brokenAlone = new Map<string, number>();
	const keys = new Map<string, Pick<BrokenSetBonus, 'setId' | 'threshold'>>();
	for (const swap of swaps) {
		for (const b of query.brokenBy([swap])) {
			const key = bonusKey(b);
			keys.set(key, b);
			brokenAlone.set(key, (brokenAlone.get(key) ?? 0) + 1);
		}
	}
	const brokenTogether = new Set<string>();
	for (const b of query.brokenBy(swaps)) {
		const key = bonusKey(b);
		keys.set(key, b);
		brokenTogether.add(key);
	}
	let estimate = query.row.ownDeltaDps + combination.reduce((s, p) => s + p.ownDeltaDps, 0);
	for (const [key, b] of keys) {
		const brokenAloneCount = brokenAlone.get(key) ?? 0;
		const brokenTogetherCount = brokenTogether.has(key) ? 1 : 0;
		const coefficient = brokenAloneCount - brokenTogetherCount;
		if (coefficient === 0) continue;
		const bonusDps = query.breakDps(b.setId, b.threshold);
		if (bonusDps === undefined) return undefined;
		estimate += coefficient * bonusDps;
	}
	return estimate;
}

export type PartnerChoice =
	| {
			itemIds: number[];
			estimatedDeltaDps?: number;
			deltaDps?: number;
	  }
	| { unmeasured: 'break-unmeasured' };

const sortedIds = (pieces: readonly { itemId: number }[]): number[] => pieces.map(p => p.itemId).sort((a, b) => a - b);

/** Negative when `a`'s sorted ids compare lower than `b`'s. */
function compareIds(a: readonly { itemId: number }[], b: readonly { itemId: number }[]): number {
	const x = sortedIds(a);
	const y = sortedIds(b);
	for (let i = 0; i < Math.min(x.length, y.length); i++) {
		if (x[i] !== y[i]) return x[i]! - y[i]!;
	}
	return x.length - y.length;
}

/** A combination 'close-calls' sims, and its 'sum-of-singles' estimate. */
export type CloseCall = { combination: PartnerPiece[]; estimate: number };

const estimated = (call: CloseCall): PartnerChoice => ({
	itemIds: call.combination.map(p => p.itemId),
	estimatedDeltaDps: call.estimate,
});

/**
 * The partners for one row and bonus when no sim can change them, else the
 * close calls to sim, best estimate first, for `pickClosest`. Undefined when
 * no combination of `needed` pieces exists. "break-unmeasured" when any
 * combination's estimate is undefined, so the row is not valued on a
 * combination chosen without that bonus. The caller sims the close calls, so
 * it can sim several rows' at once.
 */
export function closeCalls(query: PartnerQuery): { choice: PartnerChoice | undefined } | { close: CloseCall[] } {
	const combinations = partnerCombinations(query);
	if (combinations.length === 0) return { choice: undefined };

	const ranked: CloseCall[] = [];
	for (const combination of combinations) {
		const estimate = estimateCombinedDelta(query, combination);
		if (estimate === undefined) return { choice: { unmeasured: 'break-unmeasured' } };
		ranked.push({ combination, estimate });
	}
	// Highest estimate first, ties to the lowest sorted ids.
	ranked.sort((a, b) => b.estimate - a.estimate || compareIds(a.combination, b.combination));
	const top = ranked[0]!;

	const close = ranked.filter(c => c.estimate >= top.estimate - CLOSE_CALL_MARGIN_DPS);
	// One candidate needs no comparison; its gear is simmed later anyway.
	if (close.length === 1) return { choice: estimated(top) };
	return { close };
}

/**
 * The close call with the highest simmed delta; `sims[i]` is `close[i]`'s
 * sim, undefined when it was not simmed. With no sim, the best estimate.
 */
export function pickClosest(close: readonly CloseCall[], sims: readonly ({ deltaDps: number } | undefined)[]): PartnerChoice {
	let best: (CloseCall & { deltaDps: number }) | undefined;
	for (const [i, c] of close.entries()) {
		const sim = sims[i];
		if (!sim) continue;
		// Strictly greater, so a tie keeps the combination with the higher estimate.
		if (!best || sim.deltaDps > best.deltaDps) {
			best = { ...c, deltaDps: sim.deltaDps };
		}
	}
	if (!best) return estimated(close[0]!);
	return {
		itemIds: best.combination.map(p => p.itemId),
		estimatedDeltaDps: best.estimate,
		deltaDps: best.deltaDps,
	};
}
