/**
 * Picks the other pieces of a set (the partners) that a set row is simmed with to reach
 * one bonus. `choosePartners` is the only place they are picked, so the rule can be
 * swapped here alone.
 *
 * 'sum-of-singles' adds up each piece's DPS change when swapped in alone. A worn bonus
 * that several pieces each break alone is then charged more than once, and one that only
 * the full swap breaks is not charged at all, so the estimate corrects both. Ties go to
 * the lowest sorted item ids. 'close-calls', the tab's rule, sims every combination whose estimate
 * is within `CLOSE_CALL_MARGIN_DPS` of the best and keeps the highest delta.
 * 'every-combination' sims every combination and is the reference the others are scored against.
 * 'sum-of-singles-plain' (without the second correction) and 'single-swap' (the pieces
 * `pathToThreshold` picks) are kept only for that scoring.
 */

import { bonusKey, type BrokenSetBonus, type PlacedItem } from './set-value';

export type PartnerRule = 'close-calls' | 'sum-of-singles' | 'sum-of-singles-plain' | 'single-swap' | 'every-combination';

/**
 * The tab's rule. On eight test characters, no rule that picks without simming chose a
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
	/** Used by 'single-swap'. */
	pathPieces?: readonly PlacedItem[];
	/** Sims current gear plus the row plus `partners`; the delta is against current gear. */
	simGear?: (partners: readonly PlacedItem[]) => Promise<{ deltaDps: number; se: number } | undefined>;
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
 * The 'sum-of-singles' estimate of one combination, or 'sum-of-singles-plain' without
 * `includeCombinationOnlyBreaks`. Undefined when a bonus that changes the estimate is unmeasured.
 */
export function estimateCombinedDelta(query: PartnerQuery, combination: readonly PartnerPiece[], opts: { includeCombinationOnlyBreaks: boolean }): number | undefined {
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
	let est = query.row.ownDeltaDps + combination.reduce((s, p) => s + p.ownDeltaDps, 0);
	for (const [key, b] of keys) {
		const m = brokenAlone.get(key) ?? 0;
		const lost = brokenTogether.has(key) ? 1 : 0;
		if (m === 0 && !opts.includeCombinationOnlyBreaks) continue;
		const coefficient = m - lost;
		if (coefficient === 0) continue;
		const v = query.breakDps(b.setId, b.threshold);
		if (v === undefined) return undefined;
		est += coefficient * v;
	}
	return est;
}

export type PartnerAudit = {
	combinations: Array<{
		itemIds: number[];
		deltaDps: number | null;
		se: number | null;
		estimate: number | null;
		plainEstimate: number | null;
	}>;
	chosen: { itemIds: number[]; deltaDps: number };
};

export type PartnerChoice =
	| {
			itemIds: number[];
			rule: PartnerRule;
			estimatedDeltaDps?: number;
			deltaDps?: number;
			audit?: PartnerAudit;
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

/**
 * The partners for one row and bonus under `rule`. Undefined when no combination of
 * `needed` pieces exists or every "every-combination" sim failed. "break-unmeasured" when
 * any combination's estimate is undefined, so the row is not valued on a combination
 * chosen without that bonus.
 */
export async function choosePartners(query: PartnerQuery, rule: PartnerRule): Promise<PartnerChoice | undefined> {
	if (rule === 'single-swap') {
		const pieces = query.pathPieces;
		if (!pieces || pieces.length !== query.needed) return undefined;
		return {
			itemIds: [...pieces].sort((a, b) => a.slotIndex - b.slotIndex).map(p => p.itemId),
			rule,
		};
	}
	const combinations = partnerCombinations(query);
	if (combinations.length === 0) return undefined;

	if (rule === 'every-combination') {
		if (!query.simGear) return undefined;
		const audit: PartnerAudit['combinations'] = [];
		let best: { combination: PartnerPiece[]; deltaDps: number; estimate: number | undefined } | undefined;
		for (const combination of combinations) {
			const estimate = estimateCombinedDelta(query, combination, { includeCombinationOnlyBreaks: true });
			const plainEstimate = estimateCombinedDelta(query, combination, {
				includeCombinationOnlyBreaks: false,
			});
			const sim = await query.simGear(combination);
			audit.push({
				itemIds: combination.map(p => p.itemId),
				deltaDps: sim?.deltaDps ?? null,
				se: sim?.se ?? null,
				estimate: estimate ?? null,
				plainEstimate: plainEstimate ?? null,
			});
			if (!sim) continue;
			const better =
				!best ||
				sim.deltaDps > best.deltaDps ||
				(sim.deltaDps === best.deltaDps &&
					((estimate ?? -Infinity) > (best.estimate ?? -Infinity) || ((estimate ?? -Infinity) === (best.estimate ?? -Infinity) && compareIds(combination, best.combination) < 0)));
			if (better) best = { combination, deltaDps: sim.deltaDps, estimate };
		}
		if (!best) return undefined;
		const itemIds = best.combination.map(p => p.itemId);
		return {
			itemIds,
			rule,
			deltaDps: best.deltaDps,
			...(best.estimate !== undefined ? { estimatedDeltaDps: best.estimate } : {}),
			audit: { combinations: audit, chosen: { itemIds, deltaDps: best.deltaDps } },
		};
	}

	const includeCombinationOnlyBreaks = rule !== 'sum-of-singles-plain';
	const ranked: Array<{ combination: PartnerPiece[]; est: number }> = [];
	for (const combination of combinations) {
		const est = estimateCombinedDelta(query, combination, { includeCombinationOnlyBreaks });
		if (est === undefined) return { unmeasured: 'break-unmeasured' };
		ranked.push({ combination, est });
	}
	// Highest estimate first, ties to the lowest sorted ids.
	ranked.sort((a, b) => b.est - a.est || compareIds(a.combination, b.combination));
	const top = ranked[0]!;
	if (rule !== 'close-calls') {
		return {
			itemIds: top.combination.map(p => p.itemId),
			rule,
			estimatedDeltaDps: top.est,
		};
	}

	const close = ranked.filter(c => c.est >= top.est - CLOSE_CALL_MARGIN_DPS);
	// One candidate needs no comparison; its gear is simmed later anyway.
	if (close.length === 1 || !query.simGear) {
		return {
			itemIds: top.combination.map(p => p.itemId),
			rule,
			estimatedDeltaDps: top.est,
		};
	}
	let best: { combination: PartnerPiece[]; est: number; deltaDps: number } | undefined;
	for (const c of close) {
		const sim = await query.simGear(c.combination);
		if (!sim) continue;
		// Strictly greater, so a tie keeps the combination with the higher estimate.
		if (!best || sim.deltaDps > best.deltaDps) {
			best = { ...c, deltaDps: sim.deltaDps };
		}
	}
	if (!best) {
		return {
			itemIds: top.combination.map(p => p.itemId),
			rule,
			estimatedDeltaDps: top.est,
		};
	}
	return {
		itemIds: best.combination.map(p => p.itemId),
		rule,
		estimatedDeltaDps: best.est,
		deltaDps: best.deltaDps,
	};
}
