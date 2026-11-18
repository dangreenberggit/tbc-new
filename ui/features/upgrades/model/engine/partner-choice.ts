/**
 * Picks the other pieces of a set (the partners) that a set row is simmed with to reach
 * one bonus. `choosePartnerSet` is the only place they are picked, so the rule can be
 * swapped here alone.
 *
 * 'sum-of-singles' adds up each piece's DPS change when swapped in alone. A worn bonus
 * that several pieces each break alone is then charged more than once, and one that only
 * the full swap breaks is not charged at all, so the estimate corrects both. Ties go to
 * the lowest sorted item ids. 'close-calls', the tab's rule, sims every set whose estimate
 * is within `CLOSE_CALL_MARGIN_DPS` of the best and keeps the highest total.
 * 'every-combination' sims every set and is the reference the others are scored against.
 * 'sum-of-singles-plain' (without the second correction) and 'single-swap' (the pieces
 * `pathToThreshold` picks) are kept only for that scoring.
 */

import { bonusKey, type BrokenSetBonus, type PackagePiece } from './set-value';

export type PartnerRule = 'close-calls' | 'sum-of-singles' | 'sum-of-singles-plain' | 'single-swap' | 'every-combination';

/**
 * The tab's rule. On eight test characters, no rule that picks without simming chose a
 * set within noise of the best simmed set on every row.
 */
export const PARTNER_RULE: PartnerRule = 'close-calls';

/**
 * How far below the best 'sum-of-singles' estimate a set may be and still be simmed by
 * 'close-calls': twice the largest gap seen on the eight test characters between the
 * best estimate and the estimate of the set the sims found best.
 */
export const CLOSE_CALL_MARGIN_DPS = 31.866872635956497;

/** One candidate piece of the row's set, at its first sim slot. */
export type PartnerPiece = {
	itemId: number;
	slotIndex: number;
	singleDeltaDps: number;
};

/**
 * The set's pieces that were simmed alone, outside the row's slot and the slots the set
 * already fills, best per slot (lower id on a tie), in slot order. Rings, trinkets and
 * one-handers are keyed to their first slot, as in `selectPackage`.
 */
export function partnerPool(args: { pieces: readonly PartnerPiece[]; wornSetSlots: ReadonlySet<number>; rowSlotIndex: number }): PartnerPiece[] {
	const bestPerSlot = new Map<number, PartnerPiece>();
	for (const piece of args.pieces) {
		if (piece.slotIndex === args.rowSlotIndex) continue;
		if (args.wornSetSlots.has(piece.slotIndex)) continue;
		const current = bestPerSlot.get(piece.slotIndex);
		if (!current || piece.singleDeltaDps > current.singleDeltaDps || (piece.singleDeltaDps === current.singleDeltaDps && piece.itemId < current.itemId)) {
			bestPerSlot.set(piece.slotIndex, piece);
		}
	}
	return [...bestPerSlot.values()].sort((a, b) => a.slotIndex - b.slotIndex);
}

export type PartnerQuery = {
	row: { itemId: number; slotIndex: number; singleDeltaDps: number };
	setId: number;
	/** The bonus's piece count. */
	count: number;
	/** How many partner pieces reach `count` with the row worn. */
	needed: number;
	pool: readonly PartnerPiece[];
	/** The worn bonuses that count as lost when every listed swap is made. */
	lostBy: (swaps: readonly PackagePiece[]) => readonly Pick<BrokenSetBonus, 'setId' | 'threshold'>[];
	/** A worn bonus's measured value; undefined when unmeasured. */
	breakDps: (setId: number, count: number) => number | undefined;
	/** Used by 'single-swap'. */
	pathPieces?: readonly PackagePiece[];
	/** Sims current gear plus the row plus `partners`; the total is over current gear. */
	simGear?: (partners: readonly PackagePiece[]) => Promise<{ totalDps: number; se: number } | undefined>;
};

/** Every set of `needed` pool pieces, each in slot order. */
export function partnerSets(query: PartnerQuery): PartnerPiece[][] {
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
 * The 'sum-of-singles' estimate of one set, or 'sum-of-singles-plain' without
 * `withCombinationOnly`. Undefined when a bonus that changes the estimate is unmeasured.
 */
export function sumOfSinglesEstimate(query: PartnerQuery, set: readonly PartnerPiece[], opts: { withCombinationOnly: boolean }): number | undefined {
	const rowSwap: PackagePiece = {
		itemId: query.row.itemId,
		slotIndex: query.row.slotIndex,
	};
	const swaps: PackagePiece[] = [rowSwap, ...set.map(p => ({ itemId: p.itemId, slotIndex: p.slotIndex }))];
	const lostAlone = new Map<string, number>();
	const keys = new Map<string, Pick<BrokenSetBonus, 'setId' | 'threshold'>>();
	for (const swap of swaps) {
		for (const b of query.lostBy([swap])) {
			const key = bonusKey(b);
			keys.set(key, b);
			lostAlone.set(key, (lostAlone.get(key) ?? 0) + 1);
		}
	}
	const lostTogether = new Set<string>();
	for (const b of query.lostBy(swaps)) {
		const key = bonusKey(b);
		keys.set(key, b);
		lostTogether.add(key);
	}
	let est = query.row.singleDeltaDps + set.reduce((s, p) => s + p.singleDeltaDps, 0);
	for (const [key, b] of keys) {
		const m = lostAlone.get(key) ?? 0;
		const lost = lostTogether.has(key) ? 1 : 0;
		if (m === 0 && !opts.withCombinationOnly) continue;
		const coefficient = m - lost;
		if (coefficient === 0) continue;
		const v = query.breakDps(b.setId, b.threshold);
		if (v === undefined) return undefined;
		est += coefficient * v;
	}
	return est;
}

export type PartnerAudit = {
	sets: Array<{
		itemIds: number[];
		totalDps: number | null;
		se: number | null;
		estimateZ: number | null;
		estimateZ0: number | null;
	}>;
	chosen: { itemIds: number[]; totalDps: number };
};

export type PartnerChoice =
	| {
			itemIds: number[];
			rule: PartnerRule;
			estimateDps?: number;
			totalDps?: number;
			audit?: PartnerAudit;
	  }
	| { unmeasured: 'break-unmeasured' };

const sortedIds = (set: readonly { itemId: number }[]): number[] => set.map(p => p.itemId).sort((a, b) => a - b);

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
 * The partner set for one row and bonus under `rule`. Undefined when no set of `needed`
 * pieces exists or every "every-combination" sim failed. "break-unmeasured" when any set's
 * estimate is undefined, so the row is not valued on a set chosen without that bonus.
 */
export async function choosePartnerSet(query: PartnerQuery, rule: PartnerRule): Promise<PartnerChoice | undefined> {
	if (rule === 'single-swap') {
		const pieces = query.pathPieces;
		if (!pieces || pieces.length !== query.needed) return undefined;
		return {
			itemIds: [...pieces].sort((a, b) => a.slotIndex - b.slotIndex).map(p => p.itemId),
			rule,
		};
	}
	const sets = partnerSets(query);
	if (sets.length === 0) return undefined;

	if (rule === 'every-combination') {
		if (!query.simGear) return undefined;
		const audit: PartnerAudit['sets'] = [];
		let best: { set: PartnerPiece[]; totalDps: number; z: number | undefined } | undefined;
		for (const set of sets) {
			const z = sumOfSinglesEstimate(query, set, { withCombinationOnly: true });
			const z0 = sumOfSinglesEstimate(query, set, {
				withCombinationOnly: false,
			});
			const sim = await query.simGear(set);
			audit.push({
				itemIds: set.map(p => p.itemId),
				totalDps: sim?.totalDps ?? null,
				se: sim?.se ?? null,
				estimateZ: z ?? null,
				estimateZ0: z0 ?? null,
			});
			if (!sim) continue;
			const better =
				!best ||
				sim.totalDps > best.totalDps ||
				(sim.totalDps === best.totalDps &&
					((z ?? -Infinity) > (best.z ?? -Infinity) || ((z ?? -Infinity) === (best.z ?? -Infinity) && compareIds(set, best.set) < 0)));
			if (better) best = { set, totalDps: sim.totalDps, z };
		}
		if (!best) return undefined;
		const itemIds = best.set.map(p => p.itemId);
		return {
			itemIds,
			rule,
			totalDps: best.totalDps,
			...(best.z !== undefined ? { estimateDps: best.z } : {}),
			audit: { sets: audit, chosen: { itemIds, totalDps: best.totalDps } },
		};
	}

	const withCombinationOnly = rule !== 'sum-of-singles-plain';
	const ranked: Array<{ set: PartnerPiece[]; est: number }> = [];
	for (const set of sets) {
		const est = sumOfSinglesEstimate(query, set, { withCombinationOnly });
		if (est === undefined) return { unmeasured: 'break-unmeasured' };
		ranked.push({ set, est });
	}
	// Highest estimate first, ties to the lowest sorted ids.
	ranked.sort((a, b) => b.est - a.est || compareIds(a.set, b.set));
	const top = ranked[0]!;
	if (rule !== 'close-calls') {
		return {
			itemIds: top.set.map(p => p.itemId),
			rule,
			estimateDps: top.est,
		};
	}

	const close = ranked.filter(c => c.est >= top.est - CLOSE_CALL_MARGIN_DPS);
	// One candidate needs no comparison; its gear is simmed later anyway.
	if (close.length === 1 || !query.simGear) {
		return {
			itemIds: top.set.map(p => p.itemId),
			rule,
			estimateDps: top.est,
		};
	}
	let best: { set: PartnerPiece[]; est: number; totalDps: number } | undefined;
	for (const c of close) {
		const sim = await query.simGear(c.set);
		if (!sim) continue;
		// Strictly greater, so a tie keeps the set with the higher estimate.
		if (!best || sim.totalDps > best.totalDps) {
			best = { ...c, totalDps: sim.totalDps };
		}
	}
	if (!best) {
		return {
			itemIds: top.set.map(p => p.itemId),
			rule,
			estimateDps: top.est,
		};
	}
	return {
		itemIds: best.set.map(p => p.itemId),
		rule,
		estimateDps: best.est,
		totalDps: best.totalDps,
	};
}
