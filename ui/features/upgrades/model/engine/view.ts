/**
 * The view layer: a pure re-render of an existing `Ranking`, with no seam, I/O
 * or sim, and nothing here reaches `contentHash`.
 *
 * The Set-potential credit is a true net: each future's bonus (`futureBonuses`,
 * already net of package inflation) plus the other pieces' own stats on its
 * path, minus the measured breaks on that path. A row with an unmeasured figure
 * drops to disclosure-only (`rankableSetPotential`). On a step ranking
 * (`setContext.stepRanking`) the credit comes instead from sims of the gear the
 * row would be worn in (`walkSteps`).
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
 * How far the ON credit assumes a player commits.
 * "best-stop": to the threshold where committing pays best on full values,
 * or not at all; only a threshold whose bonus clears the noise floor can be
 * the stop. "full-path": to every credited threshold, counting every piece and
 * charging every break on the way. Which a player does is a preference, not a
 * game fact; the default is best-stop.
 */
export type SetCreditRule = 'best-stop' | 'full-path';
export const DEFAULT_SET_CREDIT_RULE: SetCreditRule = 'best-stop';

type SetContextLike = Partial<
	Pick<SetContext, 'futureBonuses' | 'commitBreaks' | 'singleBreaks' | 'crossesThreshold' | 'setName' | 'piecesWornBefore' | 'stepRanking' | 'singleDeltaDps'>
>;

type FutureLike = NonNullable<SetContext['futureBonuses']>[number];

/**
 * One itemised line of the ON credit, in the order the walk counts it. `dps`
 * is the signed contribution: a break is negative.
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
	 * One eligible bonus of a step ranking: its step gear's total over the
	 * current gear, the partner pieces it adds (in sim slot order) and the worn
	 * bonuses it loses. These lines are totals, not parts of the credit; `isStop`
	 * marks the one the credit stops at.
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

function sourcesOf(item: RankedItem): ItemSource[] {
	return item.sources ?? [item.source];
}

function matchesZone(item: RankedItem, zone: string): boolean {
	return sourcesOf(item).some(s => 'zone' in s && s.zone === zone);
}

function matchesBoss(item: RankedItem, zone: string | undefined, boss: string) {
	return sourcesOf(item).some(s => sourceMatchesBoss(s, boss, zone));
}

/**
 * Display label for every zoneless source kind; the raid filter groups
 * zoneless items under it. Its keys are also the kinds
 * ui/features/upgrades/utils/format.ts translates for the tab.
 */
export const SOURCE_LABELS: Record<string, string> = {
	badge: 'Badge vendor',
	crafted: 'Crafted',
	rep: 'Reputation vendor',
	pvp: 'PvP vendor',
	world: 'World drop',
	heroic: 'Heroic dungeon',
	unknown: 'Source not recorded',
};

function zoneKeyOf(item: RankedItem): string {
	for (const s of sourcesOf(item)) {
		if ('zone' in s) return s.zone;
	}
	return SOURCE_LABELS[item.source.kind] ?? item.source.kind;
}

export type RaidFilterGroup = { key: string; options: string[] };

/**
 * Zones and zoneless buckets, each under its own group key, in that order.
 * `groups.flatMap(g => g.options)` gives the same options as one flat list.
 */
export function raidFilterGroups(items: readonly RankedItem[]): RaidFilterGroup[] {
	const zoneless = new Set(Object.values(SOURCE_LABELS));
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
 * True when a row has future bonuses but some figure its ON credit depends on
 * was not measured: a future's own value, a break or a piece on a future's path,
 * or a commit break of the top package. The credit is then 0 and the tab says
 * "not counted". False without futures, since nothing is credited.
 */
export function setCreditUnmeasured(ctx: SetContextLike | undefined): boolean {
	const future = ctx?.futureBonuses ?? [];
	if (future.length === 0) return false;
	// `commitBreaks` are not read on a step ranking.
	if (ctx?.stepRanking) return future.some(stepFutureUnmeasured);
	return (
		future.some(f => f.dps === undefined || (f.breaks ?? []).some(b => b.dps === undefined) || (f.pieces ?? []).some(p => p.dps === undefined)) ||
		(ctx?.commitBreaks ?? []).some(b => b.dps === undefined)
	);
}

/**
 * On a step ranking, whether one future zeroes the row's ON credit: it lacks its
 * same-gear value and is not below the gate, or its gate cleared and it lacks
 * its step gear's sim or its partner choice. Exported so the tab's popover names
 * the same futures.
 */
export function stepFutureUnmeasured(
	f: Pick<NonNullable<SetContext['futureBonuses']>[number], 'belowGate' | 'sameGearDps' | 'stepGearDps' | 'partnerUnmeasured'>,
): boolean {
	if (f.belowGate) return false;
	if (f.sameGearDps === undefined) return true;
	return f.stepGearDps === undefined || f.partnerUnmeasured !== undefined;
}

/**
 * Which DPS-cell sub-line a set row shows: none when there is nothing to
 * disclose, "not counted" when an unmeasured figure zeroes the ON credit, else
 * the hover hint. The choice lives here so it cannot drift from
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
 * The worn bonuses one row's own swap breaks, for a row with no `setContext`
 * (only set pieces get one), so a non-set item that breaks a worn bonus does not
 * show a low figure with no reason. It applies the engine's `brokenSetBonuses`
 * to the counts the ranking measured in `brokenSetValues`, at render time, so a
 * recorded ranking shows the breaks too.
 */
export function singleSwapBreaks(
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
 * The credit arithmetic, once every figure is measured. Futures are walked in
 * threshold order; each step adds its floored bonus and the own stats of each
 * path piece no lower step counted, and subtracts each path break no lower step
 * charged. Breaks are not floored: each piece's own stats add the same value
 * back, so a row inside a measured package sums to the package's delta.
 *
 * best-stop stops where the running total is largest, or nowhere when none is
 * positive; full-path stops at the last step. Only a step whose bonus clears the
 * floor (`setBonusNoiseFloorDps`, as each bonus folds four sims) can be a stop,
 * or a row would be credited with another item's stats and no bonus; a step that
 * cannot be one still counts its pieces and breaks toward a later stop. The split
 * view takes each bonus at its per-piece share minus floored breaks, at the full
 * view's stop, unclamped since the stop is the player's. The top package's
 * `commitBreaks` are not charged: a row whose own path keeps another set's bonus
 * should not pay for a slot only the top package vacates.
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
 * Whether a step ranking's future can be a stop: it has a same-gear value and
 * that value clears the noise gate.
 */
export function stepEligible(future: Pick<FutureLike, 'belowGate' | 'sameGearDps' | 'sameGearSe'>, cutoff: Cutoff): boolean {
	if (future.belowGate || future.sameGearDps === undefined) return false;
	return clearsSameGearGate(future.sameGearDps, future.sameGearSe ?? 0, cutoff);
}

/**
 * The step rule. Walk the eligible futures in count order with
 * c = `stepGearDps` − d_r, d_r the row's single-swap figure before replication.
 * best-stop: the stop is the future whose c is strictly greater than the best
 * so far, which starts at 0; the credit is that c, or 0. full-path: the stop is
 * the last eligible future. So a credited row's `deltaDps` + credit is the sim
 * of its stop gear whenever replication did not rewrite it.
 *
 * The split view uses `sameGearDps` per piece in place of the bonus, minus each
 * newly lost worn bonus beyond the row's own break, floored, taken at the stop.
 * Each value is one sim minus another, so the floor is the item bar
 * (`cutoff.absDps`), not the four-sim floor.
 */
function walkSteps(ctx: SetContextLike, cutoff: Cutoff, rule: SetCreditRule): CreditWalk {
	const singleDeltaDps = ctx.singleDeltaDps;
	const eligible = [...(ctx.futureBonuses ?? [])]
		.filter(f => f.stepGearDps !== undefined && stepEligible(f, cutoff))
		.sort((a, b) => a.threshold - b.threshold);
	if (singleDeltaDps === undefined || eligible.length === 0) {
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
		const c = f.stepGearDps! - singleDeltaDps;
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
 * The count a crossing row's "Item stats + {set} {n}pc" label names. On a step
 * ranking it is the row's count after the swap, which the crossing gate
 * measured; elsewhere it is the next bonus above the worn count. Null when the
 * row crosses nothing.
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
 * The full-view credit and its itemised terms up to the stop, for the tab's
 * popover: each counted step's bonus (none when it floors to 0), then the pieces
 * it adds, then the breaks it charges; the terms add up to `credit`. On a step
 * ranking the terms are one `"stop"` total per eligible bonus instead, which do
 * not add up to `credit`. Call it only when `setCreditUnmeasured` is false.
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
 * One step of a step ranking's row: the partner pieces this step adds to the
 * previous step's gear, the bonus it reaches, the worn bonuses it newly loses,
 * and `dps`, its total minus the previous step's total (the first step's minus
 * the row's single swap).
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
	 * The values of the two lines a step that newly loses a worn bonus splits
	 * into: the Breaks line, the bonus-off gear's sim minus the previous
	 * total (−Y), and the pieces line, the step's total minus the bonus-off
	 * gear's sim (X). Both are present or both are absent, and they add up to
	 * `dps`.
	 */
	breaksLineDps?: number;
	piecesLineDps?: number;
};

/**
 * The step ranking's `"stop"` totals up to the stop, turned into steps whose
 * `dps` add up to the credit. Null when the row has no stop, or when a step's
 * partner pieces do not include the previous step's, because then no step is a
 * purchase on top of the one before. The first step leaves out the row's own
 * breaks, which the popover lists above the steps. A step that newly loses a
 * worn bonus gets its two line values only when its future's bonus-off sim
 * turned off exactly those bonuses; otherwise it stays one line.
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

/** The credit of `walkCredit` in the full or the split view. */
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
 * The ON-view set-potential credit for a row, in the full view or the split view
 * (each future divided by its full piece count). Each bonus is floored, strictly
 * (`>`) like the display gate, at a noise floor from the ranking's own `Cutoff`,
 * so no row sorts on a bonus the display hides (`walkCredit` and `walkSteps` say
 * which floor). When any figure the credit depends on is unmeasured
 * (`setCreditUnmeasured`), the whole credit is 0 and the row is disclosure-only,
 * gain and loss alike; an unmeasured commit break zeroes it too, although a
 * measured one is not charged.
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
