/**
 * The set-potential credit of a row and its breakdown for the popover.
 * view.ts sorts and cuts rows by `rankableSetPotential`.
 *
 * With `withSetPotential` on, a set piece's row also gets the DPS of the higher
 * set bonuses it leads to (`futureBonuses`, whose values the engine has already
 * corrected): each bonus, plus the stats of the other pieces needed to reach it,
 * minus the worn bonuses those swaps break. If any of those figures was not
 * measured the row gets nothing extra (`rankableSetPotential`). With
 * `setContext.usesBonusGear`, the credit comes instead from sims of the full gear
 * the row would be worn in (`bonusGearCredit`).
 */
import { type Cutoff, setBonusNoiseFloorDps } from './cutoff';
import { getItem } from './items';
import { simSlotsForPoolSlot } from './pool';
import type { RankedItem, Ranking, SetContext } from './rank-types';
import { clearsSameGearNoise } from './set-less-copies';
import { bonusKey, brokenSetBonuses, nextImplementedThreshold, type SetThreshold } from './set-value';
import { SIM_ORDER } from './slots';
import type { SpecId } from './types';

type SetContextLike = Partial<
	Pick<
		SetContext,
		'futureBonuses' | 'commitBreaks' | 'singleBreaks' | 'crossesThreshold' | 'setName' | 'piecesWornBefore' | 'usesBonusGear' | 'singleDeltaDps'
	>
>;

type FutureBonus = NonNullable<SetContext['futureBonuses']>[number];

/**
 * One line of the credit's breakdown, in the order `creditBreakdown` counts it. `dps`
 * is signed: a break is negative.
 */
export type SetPotentialTerm =
	| {
			kind: 'bonus';
			setName: string;
			threshold: number;
			worn: number;
			dps: number;
	  }
	| { kind: 'piece'; itemId: number; name: string; dps: number }
	| { kind: 'break'; setName: string; threshold: number; dps: number }
	/**
	 * One eligible bonus with `usesBonusGear`: the DPS of its full gear over the
	 * current gear, the partner pieces it adds (in sim slot order) and the worn
	 * bonuses it breaks. These are whole-gear gains, not parts of the credit; `isCredited` marks
	 * the bonus the credit counts up to.
	 */
	| {
			kind: 'outcome';
			threshold: number;
			setName: string;
			pieces: Array<{ itemId: number; name: string }>;
			broken: Array<{
				setId: number;
				setName: string;
				threshold: number;
				dps?: number;
			}>;
			bonusGearDps: number;
			isCredited: boolean;
	  };

/**
 * True when a row has `futureBonuses` but a figure its set-potential credit needs
 * was not measured: a bonus's own value, a piece or break on the way to it, or
 * one of `commitBreaks`. The credit is then 0 and the tab says "not counted".
 * False without `futureBonuses`, since nothing is credited.
 */
export function setCreditUnmeasured(ctx: SetContextLike | undefined): boolean {
	const future = ctx?.futureBonuses ?? [];
	if (future.length === 0) return false;
	// `commitBreaks` are not read with `usesBonusGear`.
	if (ctx?.usesBonusGear) return future.some(bonusGearUnmeasured);
	return (
		future.some(f => f.dps === undefined || (f.breaks ?? []).some(b => b.dps === undefined) || (f.pieces ?? []).some(p => p.dps === undefined)) ||
		(ctx?.commitBreaks ?? []).some(b => b.dps === undefined)
	);
}

/**
 * With `usesBonusGear`, whether one bonus makes the row's credit 0: it has no
 * `sameGearDps` and is not `belowNoise`, or it has one but lacks `bonusGearDps` or
 * its partner pieces (`partnerUnmeasured`). Exported so the tab's popover lists
 * the same bonuses.
 */
export function bonusGearUnmeasured(
	f: Pick<NonNullable<SetContext['futureBonuses']>[number], 'belowNoise' | 'sameGearDps' | 'bonusGearDps' | 'partnerUnmeasured'>,
): boolean {
	if (f.belowNoise) return false;
	if (f.sameGearDps === undefined) return true;
	return f.bonusGearDps === undefined || f.partnerUnmeasured !== undefined;
}

/**
 * Which line a set row shows under its DPS: none when there is nothing to
 * explain, "not counted" when an unmeasured figure makes the credit 0, else the
 * hover hint. It is chosen here so it cannot disagree with
 * `rankableSetPotential`.
 */
export function setBonusSubLine(ctx: SetContextLike | undefined, on: boolean): 'not_counted' | 'hover_hint' | null {
	if (!ctx) return null;
	const anyDisclosure =
		(ctx.singleBreaks ?? []).length > 0 ||
		ctx.crossesThreshold === true ||
		(ctx.futureBonuses ?? []).length > 0 ||
		(!ctx.usesBonusGear && (ctx.commitBreaks ?? []).length > 0);
	if (!anyDisclosure) return null;
	return on && setCreditUnmeasured(ctx) ? 'not_counted' : 'hover_hint';
}

export type SwapBreak = {
	setId: number;
	setName: string;
	threshold: SetThreshold;
	dps?: number;
};

/**
 * The worn set bonuses a row's own swap breaks, for a row with no `setContext`
 * (only set pieces have one). Without it, a non-set item that breaks a worn
 * bonus would show a low DPS with no reason given. It runs the engine's
 * `brokenSetBonuses` on the values in `brokenSetValues` at render time, so a
 * stored ranking shows the breaks too.
 */
export function ownSwapBreaks(
	row: Pick<RankedItem, 'itemId' | 'slot' | 'slotChoice' | 'removedItems' | 'owned' | 'simmed' | 'setContext'>,
	brokenSetValues: Ranking['brokenSetValues'],
	wornItemIds: readonly number[] | undefined,
	spec: SpecId,
): SwapBreak[] {
	if (row.setContext || row.owned || row.simmed === false || !brokenSetValues || wornItemIds?.length !== SIM_ORDER.length) {
		return [];
	}
	const valueOf = (setId: number, threshold: number) => brokenSetValues.find(v => v.setId === setId && v.threshold === threshold);
	const slotName = row.slotChoice ?? simSlotsForPoolSlot(row.slot, spec, row.itemId)[0];
	if (slotName === undefined) return [];
	// A cleared slot is a piece of item 0: it displaces the worn item and,
	// having no set, adds nothing.
	const pieces = [
		{ itemId: row.itemId, slotIndex: SIM_ORDER.indexOf(slotName) },
		...(row.removedItems ?? []).map(r => ({
			itemId: 0,
			slotIndex: SIM_ORDER.indexOf(r.slot),
		})),
	];
	return brokenSetBonuses(
		wornItemIds.map(id => ({ id, gems: [] })),
		pieces,
		getItem(row.itemId)?.setId ?? -1,
		(setId, t) => valueOf(setId, t) !== undefined,
	).map(({ setId, setName, threshold }) => {
		const dps = valueOf(setId, threshold)?.dps;
		return dps === undefined ? { setId, setName, threshold } : { setId, setName, threshold, dps };
	});
}

type CreditBreakdown = {
	credit: number;
	creditedThreshold: number;
	terms: SetPotentialTerm[];
};

/**
 * Adds up the credit, once every figure is known to be measured. Bonuses are
 * taken by piece count. Each adds its floored value and the stats of each of its
 * pieces not yet counted, and subtracts each break not yet charged. Breaks are
 * not floored: each piece's stats add the same amount back, so a row inside a
 * fully measured set of pieces sums to the gain of swapping them all.
 *
 * It credits the bonus where the running total is highest, that is, where
 * collecting the set pays most, or none when no total is positive. Only a bonus
 * above the floor (`setBonusNoiseFloorDps`, as each bonus comes from four sims)
 * can be the credited bonus, or a row would be credited with another item's
 * stats and no bonus. The pieces and breaks of a bonus below it still count
 * toward a later one. `commitBreaks` are not charged: they belong to the pieces
 * of the largest measured bonus, and a row whose own pieces keep that bonus
 * should not pay for them.
 */
function creditBreakdown(ctx: SetContextLike | undefined, cutoff: Cutoff): CreditBreakdown {
	if (ctx?.usesBonusGear) return bonusGearCredit(ctx, cutoff);
	const noiseFloorDps = setBonusNoiseFloorDps(cutoff);
	const future = [...(ctx?.futureBonuses ?? [])].sort((a, b) => a.threshold - b.threshold);
	const floored = (v: number): number => (v > noiseFloorDps ? v : 0);
	const counted = new Set<number>();
	const charged = new Set<string>();
	const terms: SetPotentialTerm[] = [];
	let running = 0;
	let best: Omit<CreditBreakdown, 'terms'> & { keep: number } = {
		credit: 0,
		creditedThreshold: 0,
		keep: 0,
	};
	for (const f of future) {
		const bonus = floored(f.dps!);
		const add = (term: Exclude<SetPotentialTerm, { kind: 'outcome' }>) => {
			terms.push(term);
			running += term.dps;
		};
		if (bonus > 0) {
			add({
				kind: 'bonus',
				setName: ctx?.setName ?? '',
				threshold: f.threshold,
				worn: ctx?.piecesWornBefore ?? 0,
				dps: bonus,
			});
		}
		for (const p of f.pieces ?? []) {
			if (counted.has(p.itemId)) continue;
			counted.add(p.itemId);
			add({ kind: 'piece', itemId: p.itemId, name: p.name, dps: p.dps! });
		}
		for (const brk of f.breaks ?? []) {
			const key = bonusKey(brk);
			if (charged.has(key)) continue;
			charged.add(key);
			if (brk.dps! === 0) continue;
			add({
				kind: 'break',
				setName: brk.setName,
				threshold: brk.threshold,
				dps: -brk.dps!,
			});
		}
		if (bonus > 0 && running > best.credit) {
			best = {
				credit: running,
				creditedThreshold: f.threshold,
				keep: terms.length,
			};
		}
	}
	return {
		credit: best.credit,
		creditedThreshold: best.creditedThreshold,
		terms: terms.slice(0, best.keep),
	};
}

/**
 * With `usesBonusGear`, whether a bonus can be the credited bonus: it has a
 * `sameGearDps` that passes `clearsSameGearNoise`.
 */
export function canBeCredited(future: Pick<FutureBonus, 'belowNoise' | 'sameGearDps' | 'sameGearSe'>, cutoff: Cutoff): boolean {
	if (future.belowNoise || future.sameGearDps === undefined) return false;
	return clearsSameGearNoise(future.sameGearDps, future.sameGearSe ?? 0, cutoff);
}

/**
 * The credit with `usesBonusGear`. For each eligible bonus by piece count,
 * c = `bonusGearDps` − `singleDeltaDps`. It credits the first bonus with the
 * highest c above 0, and that c. So a credited row's `deltaDps` + credit is the
 * sim of its full gear, unless paired replication rewrote `deltaDps`.
 */
function bonusGearCredit(ctx: SetContextLike, cutoff: Cutoff): CreditBreakdown {
	const ownDeltaDps = ctx.singleDeltaDps;
	const eligible = [...(ctx.futureBonuses ?? [])]
		.filter(f => f.bonusGearDps !== undefined && canBeCredited(f, cutoff))
		.sort((a, b) => a.threshold - b.threshold);
	if (ownDeltaDps === undefined || eligible.length === 0) {
		return { credit: 0, creditedThreshold: 0, terms: [] };
	}
	let best = { credit: 0, creditedThreshold: 0 };
	for (const f of eligible) {
		const c = f.bonusGearDps! - ownDeltaDps;
		if (c > best.credit) {
			best = { credit: c, creditedThreshold: f.threshold };
		}
	}
	const terms: SetPotentialTerm[] = eligible.map(f => ({
		kind: 'outcome',
		threshold: f.threshold,
		setName: ctx.setName ?? '',
		pieces: (f.pieces ?? []).map(p => ({ itemId: p.itemId, name: p.name })),
		broken: (f.breaks ?? []).map(b => ({
			setId: b.setId,
			setName: b.setName,
			threshold: b.threshold,
			...(b.dps !== undefined ? { dps: b.dps } : {}),
		})),
		bonusGearDps: f.bonusGearDps!,
		isCredited: f.threshold === best.creditedThreshold,
	}));
	return { ...best, terms };
}

/**
 * The piece count in the "Item stats + {set} {n}pc" label of a row that reaches
 * a new bonus (`crossesThreshold`). With `usesBonusGear` it is the count after the
 * swap, which is the count that was measured; otherwise the next bonus above
 * the worn count. Null when the row reaches no new bonus.
 */
export function crossingLabelCount(
	ctx: Pick<SetContext, 'setId' | 'piecesWornBefore' | 'piecesAfterSwap' | 'crossesThreshold' | 'usesBonusGear'> | undefined,
	usesBonusGear: boolean = ctx?.usesBonusGear === true,
): number | null {
	if (!ctx?.crossesThreshold) return null;
	if (usesBonusGear) return ctx.piecesAfterSwap;
	return nextImplementedThreshold(ctx.setId, ctx.piecesWornBefore) ?? ctx.piecesAfterSwap;
}

/**
 * The full-view credit and its breakdown up to the credited bonus, for the tab's
 * popover: each counted bonus (none when floored to 0), then the pieces it adds,
 * then the breaks it charges; the lines add up to `credit`. With `usesBonusGear`
 * there is one `"outcome"` per eligible bonus instead, and the outcomes do not add
 * up to `credit`. Call it only when `setCreditUnmeasured` is false.
 */
export function setPotentialTerms(ctx: SetContextLike | undefined, cutoff: Cutoff): { credit: number; creditedThreshold: number; terms: SetPotentialTerm[] } {
	return creditBreakdown(ctx, cutoff);
}

/**
 * One increment of a `usesBonusGear` row: the partner pieces it adds to the
 * previous increment's gear, the bonus it reaches, the worn bonuses it newly breaks,
 * and `dps`, its bonus gear's DPS minus the previous increment's (for the first
 * increment, minus the row's own swap). `dps` can be negative: a bonus before the
 * credited one can gain less than the gear before it.
 */
export type SetPotentialIncrement = {
	kind: 'increment';
	threshold: number;
	setName: string;
	pieces: Array<{ itemId: number; name: string }>;
	broken: Array<{
		setId: number;
		setName: string;
		threshold: number;
		dps?: number;
	}>;
	dps: number;
	/**
	 * True only on the last increment, the one that reaches the credited bonus.
	 * Every increment counts toward the credit.
	 */
	isCredited: boolean;
	/**
	 * An increment that newly breaks a worn bonus shows as two lines: Breaks, the
	 * sim with that bonus turned off minus the previous bonus gear's DPS, and pieces,
	 * the increment's bonus gear's DPS minus that sim. Both are set or neither is, and
	 * they add up to `dps`.
	 */
	breaksLineDps?: number;
	piecesLineDps?: number;
};

/**
 * Turns a `usesBonusGear` row's outcomes, up to the credited bonus,
 * into increments whose `dps` add up to the credit. Null when no bonus is credited,
 * or when an increment's partner pieces do not include the previous increment's,
 * because then no increment builds on the one before. The first increment leaves
 * out the row's own breaks, which the popover lists above the increments. An
 * increment gets its two line values only when its `bonusOff` sim turned off
 * exactly the bonuses it newly breaks; otherwise it stays one line.
 */
export function setPotentialIncrements(ctx: SetContextLike | undefined, cutoff: Cutoff): SetPotentialIncrement[] | null {
	if (!ctx?.usesBonusGear || ctx.singleDeltaDps === undefined) return null;
	const outcomes = bonusGearCredit(ctx, cutoff).terms.filter((t): t is Extract<SetPotentialTerm, { kind: 'outcome' }> => t.kind === 'outcome');
	const last = outcomes.findIndex(t => t.isCredited);
	if (last < 0) return null;
	let prevIds = new Set<number>();
	let prevBroken = new Set((ctx.singleBreaks ?? []).map(bonusKey));
	let prevBonusGearDps = ctx.singleDeltaDps;
	const increments: SetPotentialIncrement[] = [];
	for (const term of outcomes.slice(0, last + 1)) {
		const ids = new Set(term.pieces.map(p => p.itemId));
		if ([...prevIds].some(id => !ids.has(id))) return null;
		const broken = term.broken.filter(b => !prevBroken.has(bonusKey(b)));
		const bonus = (ctx.futureBonuses ?? []).find(f => f.threshold === term.threshold);
		const offKeys = new Set((bonus?.bonusOff ?? []).map(bonusKey));
		const offDps = bonus?.bonusOffDps;
		const split = broken.length > 0 && offDps !== undefined && offKeys.size === broken.length && broken.every(b => offKeys.has(bonusKey(b)));
		increments.push({
			kind: 'increment',
			threshold: term.threshold,
			setName: term.setName,
			pieces: term.pieces.filter(p => !prevIds.has(p.itemId)),
			broken,
			dps: term.bonusGearDps - prevBonusGearDps,
			isCredited: term.isCredited,
			...(split
				? {
						breaksLineDps: offDps - prevBonusGearDps,
						piecesLineDps: term.bonusGearDps - offDps,
					}
				: {}),
		});
		prevIds = ids;
		prevBroken = new Set([...prevBroken, ...term.broken.map(bonusKey)]);
		prevBonusGearDps = term.bonusGearDps;
	}
	return increments;
}

/** `creditBreakdown`'s credit. */
export function setPotentialCredit(ctx: SetContextLike | undefined, cutoff: Cutoff): number {
	return creditBreakdown(ctx, cutoff).credit;
}

/**
 * The set-potential credit for a row. A bonus counts only when it is above
 * (`>`, as the display checks) a noise floor from the ranking's own `Cutoff`, so
 * no row sorts on a bonus the display hides; `creditBreakdown` and `bonusGearCredit` say
 * which floor. When any figure the credit needs was not measured
 * (`setCreditUnmeasured`), the credit is 0, gains and losses alike. An
 * unmeasured commit break also makes it 0, though a measured one is not charged.
 */
export function rankableSetPotential(item: Pick<RankedItem, 'setContext'>, cutoff: Cutoff): number {
	if ((item.setContext?.futureBonuses ?? []).length === 0) return 0;
	if (setCreditUnmeasured(item.setContext)) return 0;
	return setPotentialCredit(item.setContext, cutoff);
}
