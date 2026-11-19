/**
 * Sorts, filters and groups an existing `Ranking` for display. It runs no sims,
 * and nothing here changes `contentHash`.
 *
 * With `withSetPotential` on, a set piece's row also gets the DPS of the higher
 * set bonuses it leads to (`futureBonuses`, whose values the engine has already
 * corrected): each bonus, plus the stats of the other pieces needed to reach it,
 * minus the worn bonuses those swaps break. If any of those figures was not
 * measured the row gets nothing extra (`rankableSetPotential`). With
 * `setContext.stepRanking`, the credit comes instead from sims of the full gear
 * the row would be worn in (`walkSteps`).
 */
import { type Cutoff, meetsCutoff, setBonusNoiseFloorDps } from './cutoff';
import { getItem } from './items';
import { type ItemSource, simSlotsForPoolSlot, sourceMatchesBoss } from './pool';
import type { RankedItem, Ranking, SetContext } from './rank';
import { clearsSameGearGate } from './set-less-copies';
import { bonusKey, brokenSetBonuses, nextMeasurableThreshold, type SetThreshold } from './set-value';
import { SIM_ORDER } from './slots';
import type { SpecId } from './types';

export type SetCreditView = 'full' | 'split';

/**
 * How far the set-potential credit assumes a player collects a set.
 * `'best-stop'`: up to the bonus where collecting pays most, or not at all; only
 * a bonus above the noise floor can be that point. `'full-path'`: every counted
 * bonus, with every piece and break on the way. This is a player's choice, not a
 * game rule; the default is `'best-stop'`.
 */
export type SetCreditRule = 'best-stop' | 'full-path';
export const DEFAULT_SET_CREDIT_RULE: SetCreditRule = 'best-stop';

type SetContextLike = Partial<
	Pick<SetContext, 'futureBonuses' | 'commitBreaks' | 'singleBreaks' | 'crossesThreshold' | 'setName' | 'piecesWornBefore' | 'stepRanking' | 'singleDeltaDps'>
>;

type FutureLike = NonNullable<SetContext['futureBonuses']>[number];

/**
 * One line of the credit's breakdown, in the order `walkCredit` counts it. `dps`
 * is signed: a break is negative.
 */
export type SetPotentialTerm =
	| {
			kind: 'bonus';
			setName: string;
			threshold: number;
			have: number;
			dps: number;
	  }
	| { kind: 'piece'; itemId: number; name: string; dps: number }
	| { kind: 'break'; setName: string; threshold: number; dps: number }
	/**
	 * One eligible bonus with `stepRanking`: the DPS of its full gear over the
	 * current gear, the partner pieces it adds (in sim slot order) and the worn
	 * bonuses it loses. These are totals, not parts of the credit; `isStop` marks
	 * the bonus the credit counts up to.
	 */
	| {
			kind: 'stop';
			threshold: number;
			setName: string;
			pieces: Array<{ itemId: number; name: string }>;
			broken: Array<{
				setId: number;
				setName: string;
				threshold: number;
				dps?: number;
			}>;
			totalDps: number;
			isStop: boolean;
	  };

export type ViewOptions = {
	pinBis?: boolean;
	raid?: string;
	boss?: string;
	groupBy?: 'rank' | 'slot' | 'raid';
	hideOwned?: boolean;
	withSetPotential?: boolean;
	setCredit?: SetCreditView;
};

export type ViewRow = RankedItem & {
	tieGroupId?: string;
	belowCutoffInView: boolean;
};

export type ViewResult = {
	rows: ViewRow[];
	shortlist: ViewRow[];
	belowCutoffCount: number;
	pinBisAvailable: boolean;
	groups?: Array<{ key: string; rows: ViewRow[] }>;
};

function sourcesOf(item: Pick<RankedItem, 'source' | 'sources'>): ItemSource[] {
	return item.sources ?? [item.source];
}

function matchesZone(item: RankedItem, zone: string): boolean {
	return sourcesOf(item).some(s => 'zone' in s && s.zone === zone);
}

function matchesBoss(item: RankedItem, zone: string | undefined, boss: string) {
	return sourcesOf(item).some(s => sourceMatchesBoss(s, boss, zone));
}

/** The raid filter groups zoneless items under these; `utils/format.ts` translates the keys. */
export const ZONELESS_SOURCE_LABELS: Record<string, string> = {
	badge: 'Badge vendor',
	crafted: 'Crafted',
	rep: 'Reputation vendor',
	pvp: 'PvP vendor',
	world: 'World drop',
	heroic: 'Heroic dungeon',
	unknown: 'Source not recorded',
};

export function zoneKeyOf(item: Pick<RankedItem, 'source' | 'sources'>): string {
	for (const s of sourcesOf(item)) {
		if ('zone' in s) return s.zone;
	}
	return ZONELESS_SOURCE_LABELS[item.source.kind] ?? item.source.kind;
}

export type RaidFilterGroup = { key: string; options: string[] };

/**
 * Zones and zoneless buckets, each under its own group key, in that order.
 * `groups.flatMap(g => g.options)` gives the same options as one flat list.
 */
export function raidFilterGroups(items: readonly RankedItem[]): RaidFilterGroup[] {
	const zoneless = new Set(Object.values(ZONELESS_SOURCE_LABELS));
	const zones: string[] = [];
	const buckets: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const key = zoneKeyOf(item);
		if (seen.has(key)) continue;
		seen.add(key);
		(zoneless.has(key) ? buckets : zones).push(key);
	}
	const groups: RaidFilterGroup[] = [];
	if (zones.length > 0) groups.push({ key: 'zone', options: zones });
	if (buckets.length > 0) groups.push({ key: 'other', options: buckets });
	return groups;
}

function matchesRaidFilter(item: RankedItem, value: string): boolean {
	if (matchesZone(item, value)) return true;
	const key = zoneKeyOf(item);
	return key === value && !sourcesOf(item).some(s => 'zone' in s);
}

function tieWindow(a: ViewRow, b: ViewRow): number {
	const se = a.seMethod === b.seMethod ? Math.min(a.se, b.se) : Math.max(a.se, b.se);
	return se * 2;
}

function assignTieGroups(rows: ViewRow[], sortKey: (r: ViewRow) => number): void {
	const groupIdRef = { next: 1 };
	const byDelta = [...rows].sort((a, b) => sortKey(b) - sortKey(a));
	let groupStart = 0;

	const flush = (end: number) => {
		if (end - groupStart > 1) {
			const id = `tie-${groupIdRef.next}`;
			groupIdRef.next += 1;
			for (let i = groupStart; i < end; i += 1) byDelta[i]!.tieGroupId = id;
		}
	};

	for (let i = 1; i <= byDelta.length; i += 1) {
		const leader = byDelta[groupStart]!;
		const row = byDelta[i];
		const overlapsLeader = row !== undefined && sortKey(leader) - sortKey(row) <= tieWindow(row, leader);
		if (!overlapsLeader) {
			flush(i);
			groupStart = i;
		}
	}
}

function belowCutoffUnderView(item: RankedItem, withSetPotential: boolean, cutoff: Cutoff, setCredit: SetCreditView): boolean {
	if (!withSetPotential) return item.belowCutoff;
	const prospective = rankableSetPotential(item, cutoff, setCredit);
	if (prospective === 0) return item.belowCutoff;
	return !meetsCutoff(item.deltaDps + prospective, cutoff);
}

/**
 * True when a row has `futureBonuses` but a figure its set-potential credit needs
 * was not measured: a bonus's own value, a piece or break on the way to it, or
 * one of `commitBreaks`. The credit is then 0 and the tab says "not counted".
 * False without `futureBonuses`, since nothing is credited.
 */
export function setCreditUnmeasured(ctx: SetContextLike | undefined): boolean {
	const future = ctx?.futureBonuses ?? [];
	if (future.length === 0) return false;
	// `commitBreaks` are not read with `stepRanking`.
	if (ctx?.stepRanking) return future.some(stepFutureUnmeasured);
	return (
		future.some(f => f.dps === undefined || (f.breaks ?? []).some(b => b.dps === undefined) || (f.pieces ?? []).some(p => p.dps === undefined)) ||
		(ctx?.commitBreaks ?? []).some(b => b.dps === undefined)
	);
}

/**
 * With `stepRanking`, whether one bonus makes the row's credit 0: it has no
 * `sameGearDps` and is not `belowGate`, or it has one but lacks `stepGearDps` or
 * its partner pieces (`partnerUnmeasured`). Exported so the tab's popover lists
 * the same bonuses.
 */
export function stepFutureUnmeasured(
	f: Pick<NonNullable<SetContext['futureBonuses']>[number], 'belowGate' | 'sameGearDps' | 'stepGearDps' | 'partnerUnmeasured'>,
): boolean {
	if (f.belowGate) return false;
	if (f.sameGearDps === undefined) return true;
	return f.stepGearDps === undefined || f.partnerUnmeasured !== undefined;
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
		(!ctx.stepRanking && (ctx.commitBreaks ?? []).length > 0);
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

type CreditWalk = {
	credit: number;
	split: number;
	stopThreshold: number;
	terms: SetPotentialTerm[];
};

/**
 * Adds up the credit, once every figure is known to be measured. Bonuses are
 * taken by piece count. Each adds its floored value and the stats of each of its
 * pieces not yet counted, and subtracts each break not yet charged. Breaks are
 * not floored: each piece's stats add the same amount back, so a row inside a
 * fully measured set of pieces sums to the gain of swapping them all.
 *
 * `'best-stop'` stops where the running total is highest, or nowhere when no
 * total is positive; `'full-path'` stops at the last bonus. Only a bonus above
 * the floor (`setBonusNoiseFloorDps`, as each bonus comes from four sims) can be
 * the stopping point, or a row would be credited with another item's stats and
 * no bonus. The pieces and breaks of a bonus below it still count toward a later
 * one. The `'split'` view takes each bonus per piece, minus floored breaks, at
 * the same point, and may go negative, since where to stop is the player's
 * choice. `commitBreaks` are not charged: they belong to the pieces of the
 * largest measured bonus, and a row whose own pieces keep that bonus should not
 * pay for them.
 */
function walkCredit(ctx: SetContextLike | undefined, cutoff: Cutoff, rule: SetCreditRule): CreditWalk {
	if (ctx?.stepRanking) return walkSteps(ctx, cutoff, rule);
	const noiseFloorDps = setBonusNoiseFloorDps(cutoff);
	const future = [...(ctx?.futureBonuses ?? [])].sort((a, b) => a.threshold - b.threshold);
	const floored = (v: number): number => (v > noiseFloorDps ? v : 0);
	const counted = new Set<number>();
	const charged = new Set<string>();
	const terms: SetPotentialTerm[] = [];
	let running = 0;
	let splitRunning = 0;
	let best: Omit<CreditWalk, 'terms'> & { keep: number } = {
		credit: 0,
		split: 0,
		stopThreshold: 0,
		keep: 0,
	};
	for (const f of future) {
		const bonus = floored(f.dps!);
		if (rule === 'full-path' && bonus === 0) continue;
		const add = (term: Exclude<SetPotentialTerm, { kind: 'stop' }>) => {
			terms.push(term);
			running += term.dps;
		};
		if (bonus > 0) {
			add({
				kind: 'bonus',
				setName: ctx?.setName ?? '',
				threshold: f.threshold,
				have: ctx?.piecesWornBefore ?? 0,
				dps: bonus,
			});
		}
		for (const p of f.pieces ?? []) {
			if (counted.has(p.itemId)) continue;
			counted.add(p.itemId);
			add({ kind: 'piece', itemId: p.itemId, name: p.name, dps: p.dps! });
		}
		let splitLoss = 0;
		for (const brk of f.breaks ?? []) {
			const key = bonusKey(brk);
			if (charged.has(key)) continue;
			charged.add(key);
			splitLoss += floored(brk.dps!);
			if (brk.dps! === 0) continue;
			add({
				kind: 'break',
				setName: brk.setName,
				threshold: brk.threshold,
				dps: -brk.dps!,
			});
		}
		splitRunning += floored(f.dps! / f.threshold) - splitLoss;
		if (rule === 'full-path' || (bonus > 0 && running > best.credit)) {
			best = {
				credit: running,
				split: splitRunning,
				stopThreshold: f.threshold,
				keep: terms.length,
			};
		}
	}
	return {
		credit: best.credit,
		split: best.split,
		stopThreshold: best.stopThreshold,
		terms: terms.slice(0, best.keep),
	};
}

/**
 * With `stepRanking`, whether a bonus can be the stopping point: it has a
 * `sameGearDps` that passes `clearsSameGearGate`.
 */
export function stepEligible(future: Pick<FutureLike, 'belowGate' | 'sameGearDps' | 'sameGearSe'>, cutoff: Cutoff): boolean {
	if (future.belowGate || future.sameGearDps === undefined) return false;
	return clearsSameGearGate(future.sameGearDps, future.sameGearSe ?? 0, cutoff);
}

/**
 * The credit with `stepRanking`. For each eligible bonus by piece count,
 * c = `stepGearDps` − `singleDeltaDps`. `'best-stop'` stops at the first bonus
 * with the highest c above 0 and credits that c; `'full-path'` stops at the last
 * eligible bonus. So a credited row's `deltaDps` + credit is the sim of its full
 * gear, unless paired replication rewrote `deltaDps`.
 *
 * The `'split'` view uses `sameGearDps` per piece instead, minus each newly lost
 * worn bonus beyond the row's own breaks, floored, up to the stopping point.
 * Each value is one sim minus another, so the floor is `cutoff.absDps`, not the
 * four-sim floor.
 */
function walkSteps(ctx: SetContextLike, cutoff: Cutoff, rule: SetCreditRule): CreditWalk {
	const ownDeltaDps = ctx.singleDeltaDps;
	const eligible = [...(ctx.futureBonuses ?? [])]
		.filter(f => f.stepGearDps !== undefined && stepEligible(f, cutoff))
		.sort((a, b) => a.threshold - b.threshold);
	if (ownDeltaDps === undefined || eligible.length === 0) {
		return { credit: 0, split: 0, stopThreshold: 0, terms: [] };
	}
	const floored = (v: number): number => (v > cutoff.absDps ? v : 0);
	const charged = new Set((ctx.singleBreaks ?? []).map(bonusKey));
	let splitRunning = 0;
	let best = { credit: 0, split: 0, stopThreshold: 0 };
	for (const f of eligible) {
		let splitLoss = 0;
		for (const brk of f.breaks ?? []) {
			const key = bonusKey(brk);
			if (charged.has(key)) continue;
			charged.add(key);
			splitLoss += floored(brk.dps ?? 0);
		}
		splitRunning += floored(f.sameGearDps! / f.threshold) - splitLoss;
		const c = f.stepGearDps! - ownDeltaDps;
		if (rule === 'full-path' || c > best.credit) {
			best = { credit: c, split: splitRunning, stopThreshold: f.threshold };
		}
	}
	const terms: SetPotentialTerm[] = eligible.map(f => ({
		kind: 'stop',
		threshold: f.threshold,
		setName: ctx.setName ?? '',
		pieces: (f.pieces ?? []).map(p => ({ itemId: p.itemId, name: p.name })),
		broken: (f.breaks ?? []).map(b => ({
			setId: b.setId,
			setName: b.setName,
			threshold: b.threshold,
			...(b.dps !== undefined ? { dps: b.dps } : {}),
		})),
		totalDps: f.stepGearDps!,
		isStop: f.threshold === best.stopThreshold,
	}));
	return { ...best, terms };
}

/**
 * The piece count in the "Item stats + {set} {n}pc" label of a row that reaches
 * a new bonus (`crossesThreshold`). With `stepRanking` it is the count after the
 * swap, which is the count that was measured; otherwise the next bonus above
 * the worn count. Null when the row reaches no new bonus.
 */
export function crossingLabelCount(
	ctx: Pick<SetContext, 'setId' | 'piecesWornBefore' | 'piecesAfterSwap' | 'crossesThreshold' | 'stepRanking'> | undefined,
	stepRanking: boolean = ctx?.stepRanking === true,
): number | null {
	if (!ctx?.crossesThreshold) return null;
	if (stepRanking) return ctx.piecesAfterSwap;
	return nextMeasurableThreshold(ctx.setId, ctx.piecesWornBefore) ?? ctx.piecesAfterSwap;
}

/**
 * The full-view credit and its breakdown up to the stopping point, for the tab's
 * popover: each counted bonus (none when floored to 0), then the pieces it adds,
 * then the breaks it charges; the lines add up to `credit`. With `stepRanking`
 * there is one `"stop"` total per eligible bonus instead, and those do not add
 * up to `credit`. Call it only when `setCreditUnmeasured` is false.
 */
export function setPotentialTerms(
	ctx: SetContextLike | undefined,
	cutoff: Cutoff,
	rule: SetCreditRule = DEFAULT_SET_CREDIT_RULE,
): { credit: number; stopThreshold: number; terms: SetPotentialTerm[] } {
	const { credit, stopThreshold, terms } = walkCredit(ctx, cutoff, rule);
	return { credit, stopThreshold, terms };
}

/**
 * One step of a `stepRanking` row: the partner pieces it adds to the previous
 * step's gear, the bonus it reaches, the worn bonuses it newly loses, and `dps`,
 * its total minus the previous step's (for the first step, minus the row's own
 * swap).
 */
export type SetPotentialStep = {
	kind: 'step';
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
	isStop: boolean;
	/**
	 * A step that newly loses a worn bonus shows as two lines: Breaks, the sim
	 * with that bonus turned off minus the previous total, and pieces, the step's
	 * total minus that sim. Both are set or neither is, and they add up to `dps`.
	 */
	breaksLineDps?: number;
	piecesLineDps?: number;
};

/**
 * Turns a `stepRanking` row's `"stop"` totals, up to the stopping point, into
 * steps whose `dps` add up to the credit. Null when there is no stopping point,
 * or when a step's partner pieces do not include the previous step's, because
 * then no step builds on the one before. The first step leaves out the row's own
 * breaks, which the popover lists above the steps. A step gets its two line
 * values only when its `bonusOff` sim turned off exactly the bonuses it newly
 * loses; otherwise it stays one line.
 */
export function setPotentialSteps(ctx: SetContextLike | undefined, cutoff: Cutoff, rule: SetCreditRule = DEFAULT_SET_CREDIT_RULE): SetPotentialStep[] | null {
	if (!ctx?.stepRanking || ctx.singleDeltaDps === undefined) return null;
	const stops = walkSteps(ctx, cutoff, rule).terms.filter((t): t is Extract<SetPotentialTerm, { kind: 'stop' }> => t.kind === 'stop');
	const last = stops.findIndex(t => t.isStop);
	if (last < 0) return null;
	let prevIds = new Set<number>();
	let prevBroken = new Set((ctx.singleBreaks ?? []).map(bonusKey));
	let prevTotal = ctx.singleDeltaDps;
	const steps: SetPotentialStep[] = [];
	for (const term of stops.slice(0, last + 1)) {
		const ids = new Set(term.pieces.map(p => p.itemId));
		if ([...prevIds].some(id => !ids.has(id))) return null;
		const broken = term.broken.filter(b => !prevBroken.has(bonusKey(b)));
		const fut = (ctx.futureBonuses ?? []).find(f => f.threshold === term.threshold);
		const offKeys = new Set((fut?.bonusOff ?? []).map(bonusKey));
		const offDps = fut?.bonusOffDps;
		const split = broken.length > 0 && offDps !== undefined && offKeys.size === broken.length && broken.every(b => offKeys.has(bonusKey(b)));
		steps.push({
			kind: 'step',
			threshold: term.threshold,
			setName: term.setName,
			pieces: term.pieces.filter(p => !prevIds.has(p.itemId)),
			broken,
			dps: term.totalDps - prevTotal,
			isStop: term.isStop,
			...(split
				? {
						breaksLineDps: offDps - prevTotal,
						piecesLineDps: term.totalDps - offDps,
					}
				: {}),
		});
		prevIds = ids;
		prevBroken = new Set([...prevBroken, ...term.broken.map(bonusKey)]);
		prevTotal = term.totalDps;
	}
	return steps;
}

/** `walkCredit`'s credit for the full or the `'split'` view. */
export function setPotentialCredit(
	ctx: SetContextLike | undefined,
	cutoff: Cutoff,
	setCredit: SetCreditView = 'full',
	rule: SetCreditRule = DEFAULT_SET_CREDIT_RULE,
): number {
	const walk = walkCredit(ctx, cutoff, rule);
	return setCredit === 'split' ? walk.split : walk.credit;
}

/**
 * The set-potential credit for a row, for the full or the `'split'` view (each
 * bonus divided by its full piece count). A bonus counts only when it is above
 * (`>`, as the display checks) a noise floor from the ranking's own `Cutoff`, so
 * no row sorts on a bonus the display hides; `walkCredit` and `walkSteps` say
 * which floor. When any figure the credit needs was not measured
 * (`setCreditUnmeasured`), the credit is 0, gains and losses alike. An
 * unmeasured commit break also makes it 0, though a measured one is not charged.
 */
export function rankableSetPotential(item: Pick<RankedItem, 'setContext'>, cutoff: Cutoff, setCredit: SetCreditView = 'full'): number {
	if ((item.setContext?.futureBonuses ?? []).length === 0) return 0;
	if (setCreditUnmeasured(item.setContext)) return 0;
	return setPotentialCredit(item.setContext, cutoff, setCredit);
}

function sortKeyFor(withSetPotential: boolean, cutoff: Cutoff, setCredit: SetCreditView = 'full'): (r: ViewRow) => number {
	return withSetPotential ? r => r.deltaDps + rankableSetPotential(r, cutoff, setCredit) : r => r.deltaDps;
}

function compareRows(a: ViewRow, b: ViewRow, pinBis: boolean, sortKey: (r: ViewRow) => number): number {
	if (pinBis) {
		const ap = a.bisTags.includes('BiS') ? 0 : 1;
		const bp = b.bisTags.includes('BiS') ? 0 : 1;
		if (ap !== bp) return ap - bp;
	}
	const ak = sortKey(a);
	const bk = sortKey(b);
	if (ak !== bk) return bk - ak;
	const richness = b.bisTags.length - a.bisTags.length;
	if (richness !== 0) return richness;
	return a.itemId - b.itemId;
}

export function applyView(r: Ranking, v: ViewOptions = {}): ViewResult {
	const pinBis = v.pinBis ?? false;
	const zone = v.raid === undefined || v.raid === 'all' ? undefined : v.raid;
	const boss = v.boss === undefined || v.boss === 'all' ? undefined : v.boss;
	const setCredit = v.setCredit ?? 'full';
	const sortKey = sortKeyFor(v.withSetPotential ?? false, r.cutoff, setCredit);

	const rows: ViewRow[] = r.items
		.filter(item => {
			if (v.hideOwned === true && item.owned === true) return false;
			if (zone !== undefined && !matchesRaidFilter(item, zone)) return false;
			if (boss !== undefined && !matchesBoss(item, zone, boss)) return false;
			return true;
		})
		.map(item => ({
			...item,
			belowCutoffInView: belowCutoffUnderView(item, v.withSetPotential ?? false, r.cutoff, setCredit),
		}));

	rows.sort((a, b) => compareRows(a, b, pinBis, sortKey));

	assignTieGroups(rows, sortKey);

	const pinBisAvailable = r.items.some(i => i.bisTags.includes('BiS'));
	const shortlist = rows.filter(row => !row.belowCutoffInView);
	const result: ViewResult = {
		rows,
		shortlist,
		belowCutoffCount: rows.length - shortlist.length,
		pinBisAvailable,
	};

	if (v.groupBy === 'slot' || v.groupBy === 'raid') {
		const keyOf = v.groupBy === 'slot' ? (i: ViewRow) => i.slot : zoneKeyOf;
		const groups = new Map<string, ViewRow[]>();
		for (const row of rows) {
			const key = keyOf(row);
			const bucket = groups.get(key);
			if (bucket) bucket.push(row);
			else groups.set(key, [row]);
		}
		result.groups = [...groups].map(([key, groupRows]) => ({
			key,
			rows: groupRows,
		}));
	}

	return result;
}
