/**
 * The set-bonus popover of a result row, as data. Usually its lines add up to the
 * figure the cell shows (`kind: 'receipt'`). When a row's bonuses need pieces that
 * do not build on each other, each line is a separate result (`kind: 'outcomes'`).
 * `utils/set_bonus_labels.ts` turns it into text.
 */

import type { Cutoff } from './engine/cutoff';
import type { RankedItem, Ranking, SetContext } from './engine/rank';
import { clearsSameGearGate } from './engine/set-less-copies';
import type { ScreenReason } from './engine/set-screen';
import { bonusKey } from './engine/set-value';
import type { SpecId } from './engine/types';
import {
	crossingLabelCount,
	rankableSetPotential,
	setBonusSubLine,
	setCreditUnmeasured,
	setPotentialSteps,
	type SetPotentialTerm,
	setPotentialTerms,
	ownSwapBreaks,
	stepEligible,
	stepFutureUnmeasured,
} from './engine/view';
import { shownTenths, tenthsOf } from './shown_figure';

/** A set bonus as a label names it: "{set} {count}pc". */
export type BonusRef = { setName: string; threshold: number };

export type TipLabel =
	/** The row's own stats. Names the bonus it completes, and any worn bonus it breaks that was not measured, as that loss is then inside this line. */
	| { kind: 'item_stats'; bonus?: BonusRef; unmeasuredBreaks: BonusRef[] }
	| { kind: 'breaks'; broken: BonusRef[] }
	| { kind: 'bonus'; set: string; threshold: number; have: number }
	| { kind: 'piece_stats'; name: string }
	/** One step toward a bonus: the other pieces needed, the bonus they reach and the worn bonuses lost. */
	| { kind: 'pieces'; form: 'stop' | 'step'; pieces: string[]; threshold: number; broken: BonusRef[] }
	| { kind: 'item_alone'; name: string; broken: BonusRef[] }
	/** A bonus the row can reach that its figure does not count, with the other pieces needed and the extra worn bonuses lost. */
	| { kind: 'reachable'; set: string; threshold: number; have: number; pieces: string[]; broken: BonusRef[] }
	/** A set that `set-screen.ts` dropped, so none of its bonuses was measured for the row. */
	| { kind: 'screened'; set: string; reason: ScreenedReason }
	/** A bonus whose measured value is too small to tell from sim noise, so it has no figure. */
	| { kind: 'noise'; set: string; threshold: number }
	| { kind: 'total' };

const SCREENED_REASONS = ['outside-band', 'exact-zero', 'below-zero'] as const satisfies readonly ScreenReason[];
export type ScreenedReason = (typeof SCREENED_REASONS)[number];

/**
 * `dps` undefined means not measured. Lines above the total are already rounded
 * to tenths so they add up to it. `marker` flags the result the row's figure uses;
 * `outcome` flags a line after the total that is compared, not added.
 */
export type TipEntry =
	| { type: 'heading'; heading: 'set_potential' | 'set_potential_totals' | 'not_counted_off' | 'not_counted_no_gain' | 'not_counted' }
	| { type: 'line'; label: TipLabel; dps: number | undefined; marker?: true; outcome?: true; againstStop?: true; belowNoise?: true };

export type SetBonusTip = { subLine: 'hover_hint' | 'not_counted'; kind: 'receipt' | 'outcomes'; entries: TipEntry[] };

export type SetBonusTipContext = {
	/** Absent while a run is in flight: there is no cutoff yet, so no set potential and no bonuses lost to the row's own swap. */
	ranking?: Pick<Ranking, 'cutoff' | 'brokenSetValues' | 'setBonuses' | 'setScreen'>;
	/** The gear the ranking was measured on, in sim slot order. */
	wornItemIds?: readonly number[];
	specId?: SpecId;
	withSetPotential?: boolean;
};

type Line = { label: TipLabel; dps: number | undefined; figure?: boolean };

/** Raw unless `shownTenths` moved it below the cutoff, so a figure it leaves alone keeps its full precision. */
const shownValue = (v: number, bar: number | undefined): number => (shownTenths(v, bar) === tenthsOf(v) ? v : shownTenths(v, bar) / 10);

/**
 * Rounds `values` to tenths so they add up to exactly `target` tenths, moving
 * the fewest lines by one tenth each (largest remainder). Rounding each line
 * alone can leave the shown lines a tenth off their shown total.
 */
export function spreadTenths(values: readonly number[], target: number): number[] {
	const out = values.map(tenthsOf);
	const diff = target - out.reduce((a, b) => a + b, 0);
	if (diff === 0 || out.length === 0) return out;
	const rem = values.map((v, i) => v * 10 - out[i]!);
	const order = values.map((_, i) => i).sort((a, b) => (diff > 0 ? rem[b]! - rem[a]! : rem[a]! - rem[b]!));
	for (let k = 0; k < Math.abs(diff); k++) out[order[k % order.length]!]! += Math.sign(diff);
	return out;
}

const ref = (b: BonusRef): BonusRef => ({ setName: b.setName, threshold: b.threshold });
const line = (label: TipLabel, dps: number | undefined, marker?: boolean): TipEntry => ({
	type: 'line',
	label,
	dps,
	...(marker ? { marker: true as const } : {}),
});
const piecesLine = (form: 'stop' | 'step', term: { pieces: ReadonlyArray<{ name: string }>; threshold: number; broken: readonly BonusRef[] }): TipLabel => ({
	kind: 'pieces',
	form,
	pieces: term.pieces.map(p => p.name),
	threshold: term.threshold,
	broken: term.broken.map(ref),
});

/** `stopThreshold` is the bonus a `steps` section stops at. */
type Potential = { lines: Line[]; kind: 'unmeasured' | 'none' | 'itemised' | 'steps' | 'outcomes'; stopThreshold?: number };
const NO_POTENTIAL: Potential = { lines: [], kind: 'none' };

/**
 * The Set potential lines, with the toggle on. `unmeasured` lists each figure
 * missing from `credit`; `none` when `credit` is 0; `itemised` its parts; `steps`
 * each step up to `stopThreshold`, adding up to `credit`; `outcomes` one total per
 * bonus when the bonuses' pieces do not build on each other.
 */
function potentialLines(ctx: SetContext, cutoff: Cutoff, credit: number): Potential {
	const futures = [...(ctx.futureBonuses ?? [])].sort((a, b) => a.threshold - b.threshold);
	const bonusLabel = (threshold: number): TipLabel => ({ kind: 'bonus', set: ctx.setName, threshold, have: ctx.piecesWornBefore });
	if (setCreditUnmeasured(ctx) && ctx.stepRanking) {
		return { lines: futures.filter(stepFutureUnmeasured).map(f => ({ label: bonusLabel(f.threshold), dps: undefined })), kind: 'unmeasured' };
	}
	if (setCreditUnmeasured(ctx)) {
		const lines: Line[] = [];
		const named = new Set((ctx.singleBreaks ?? []).map(bonusKey));
		const nameUnmeasuredBreak = (b: BonusRef & { setId: number; dps?: number }) => {
			if (b.dps !== undefined || named.has(bonusKey(b))) return;
			named.add(bonusKey(b));
			lines.push({ label: { kind: 'breaks', broken: [ref(b)] }, dps: undefined });
		};
		for (const f of futures) {
			if (f.dps === undefined) lines.push({ label: bonusLabel(f.threshold), dps: undefined });
			for (const b of f.breaks ?? []) nameUnmeasuredBreak(b);
		}
		for (const b of ctx.commitBreaks ?? []) nameUnmeasuredBreak(b);
		return { lines, kind: 'unmeasured' };
	}
	if (credit === 0) return NO_POTENTIAL;
	if (ctx.stepRanking) {
		const steps = setPotentialSteps(ctx, cutoff);
		if (steps !== null) {
			const lines = steps.flatMap((s): Line[] =>
				s.breaksLineDps === undefined || s.piecesLineDps === undefined
					? [{ label: piecesLine('step', s), dps: s.dps }]
					: [
							{ label: { kind: 'breaks', broken: s.broken.map(ref) }, dps: s.breaksLineDps },
							{ label: piecesLine('step', { ...s, broken: [] }), dps: s.piecesLineDps },
						],
			);
			return { lines, kind: 'steps', stopThreshold: steps.at(-1)!.threshold };
		}
		const lines = setPotentialTerms(ctx, cutoff)
			.terms.filter((term): term is Extract<SetPotentialTerm, { kind: 'stop' }> => term.kind === 'stop')
			.map(term => ({ label: piecesLine('stop', term), dps: term.totalDps, figure: term.isStop }));
		return { lines, kind: 'outcomes' };
	}
	const lines = setPotentialTerms(ctx, cutoff).terms.map((term): Line => {
		switch (term.kind) {
			case 'bonus':
				return { label: { kind: 'bonus', set: term.setName, threshold: term.threshold, have: term.have }, dps: term.dps };
			case 'piece':
				return { label: { kind: 'piece_stats', name: term.name }, dps: term.dps };
			case 'break':
				return { label: { kind: 'breaks', broken: [ref(term)] }, dps: term.dps };
			case 'stop':
				return { label: piecesLine('stop', term), dps: term.totalDps };
		}
	});
	return { lines, kind: 'itemised' };
}

/**
 * The bonuses a `stepRanking` row can reach that its figure does not count. Each
 * figure is how much the row's figure would change if it counted that step instead:
 * against the row alone, or for steps past `stopThreshold`, against the gear at
 * `stopThreshold`. A difference too small to tell from noise gets no figure. Without `stepRanking` a
 * future bonus's figure is the bonus alone, which these labels would misstate.
 */
function reachableLines(row: RankedItem, ctx: SetContext, cutoff: Cutoff, stopThreshold?: number): TipEntry[] {
	if (!ctx.stepRanking) return [];
	const own = new Set((ctx.singleBreaks ?? []).map(bonusKey));
	const stop = stopThreshold === undefined ? undefined : ctx.futureBonuses?.find(f => f.threshold === stopThreshold);
	if (stopThreshold !== undefined && stop?.stepGearDps === undefined) return [];
	const reference = stop?.stepGearDps ?? ctx.singleDeltaDps ?? row.deltaDps;
	return [...(ctx.futureBonuses ?? [])]
		.sort((a, b) => a.threshold - b.threshold)
		.filter(f => f.threshold > (stopThreshold ?? 0) && stepEligible(f, cutoff))
		.map((f): TipEntry => {
			const dps = f.stepGearDps === undefined ? undefined : f.stepGearDps - reference;
			// Both `stepGearDps` values are measured against the same baseline sim, so
			// `Math.hypot` of their errors counts the baseline's error twice. The test
			// leans toward "too small to measure".
			const belowNoise =
				stop !== undefined && dps !== undefined && !clearsSameGearGate(Math.abs(dps), Math.hypot(f.stepGearSe ?? 0, stop.stepGearSe ?? 0), cutoff);
			return {
				type: 'line',
				label: {
					kind: 'reachable',
					set: ctx.setName,
					threshold: f.threshold,
					have: ctx.piecesWornBefore,
					pieces: (f.pieces ?? []).map(p => p.name),
					broken: (f.breaks ?? []).filter(b => !own.has(bonusKey(b))).map(ref),
				},
				dps: belowNoise ? undefined : dps,
				outcome: true,
				...(stop ? { againstStop: true as const } : {}),
				...(belowNoise ? { belowNoise: true as const } : {}),
			};
		});
}

/**
 * When every bonus of a `stepRanking` row is too small to tell from noise, they are
 * listed with no figure, so the row still says its set was tried.
 */
function noiseLines(ctx: SetContext, cutoff: Cutoff): TipEntry[] {
	const futures = ctx.futureBonuses ?? [];
	if (!ctx.stepRanking || futures.some(f => stepEligible(f, cutoff))) return [];
	return futures
		.filter(f => f.belowGate)
		.sort((a, b) => a.threshold - b.threshold)
		.map(f => line({ kind: 'noise', set: ctx.setName, threshold: f.threshold }, undefined));
}

/** The toggle is never why a set `set-screen.ts` dropped is not counted, so a section with no reachable line names no reason. */
function notCountedHeading(hasReachable: boolean, on: boolean): Extract<TipEntry, { type: 'heading' }>['heading'] {
	if (!hasReachable) return 'not_counted';
	return on ? 'not_counted_no_gain' : 'not_counted_off';
}

/**
 * No figure on purpose: a `below-zero` measure is the pieces and the bonus
 * together, so printing it as the bonus would blame the bonus for the pieces' loss.
 */
function screenedLine(ctx: SetContext, ranking: SetBonusTipContext['ranking']): TipEntry | null {
	const screen = ranking?.setScreen?.mode === 'on' ? ranking.setScreen.sets.find(s => s.setId === ctx.setId) : undefined;
	// Older rankings also mark the set with a "screened-out" entry.
	const marked = ranking?.setBonuses?.some(b => b.setId === ctx.setId && b.unmeasured === 'screened-out') ?? false;
	if (screen?.kept !== false && !marked) return null;
	// With no screen entry to read, "not measured" is the one value that is still true.
	const reason = SCREENED_REASONS.find(r => r === screen?.reason) ?? 'outside-band';
	return line({ kind: 'screened', set: ctx.setName, reason }, undefined);
}

/**
 * Each line is a separate result against the current gear, so there is no Item
 * stats line and no total. Every total shifts by as much as the re-sim with more
 * seeds moved the row's own figure. The item-alone and `marker` lines then match the
 * cell with the toggle off and on, so they are rounded as the cell is.
 */
function outcomesEntries(row: RankedItem, ctx: SetContext, outcomes: readonly Line[], bar: number | undefined): TipEntry[] {
	const shift = row.deltaDps - (ctx.singleDeltaDps ?? row.deltaDps);
	return [
		{ type: 'heading', heading: 'set_potential_totals' },
		line({ kind: 'item_alone', name: row.name, broken: (ctx.singleBreaks ?? []).map(ref) }, shownValue(row.deltaDps, bar)),
		...outcomes.map(o => line(o.label, o.figure ? shownValue((o.dps ?? 0) + shift, bar) : (o.dps ?? 0) + shift, o.figure)),
	];
}

/**
 * The popover of `row`, or null when it has nothing to say. The first "Item stats"
 * line balances the toggle-off lines and keeps its value across the toggle, so the
 * toggle's rounding goes into the Set potential lines.
 */
export function setBonusTipLines(row: RankedItem, context: SetBonusTipContext = {}): SetBonusTip | null {
	const ctx = row.setContext;
	const cutoff = context.ranking?.cutoff;
	const bar = cutoff?.absDps;
	const on = (context.withSetPotential ?? false) && cutoff !== undefined;
	const credit = on ? rankableSetPotential(row, cutoff, 'full') : 0;
	// A row with no `setContext` still lists the worn bonuses its own swap breaks.
	const ownBreaks =
		ctx || !context.ranking || !context.specId ? [] : ownSwapBreaks(row, context.ranking.brokenSetValues, context.wornItemIds, context.specId);
	if (!ctx && ownBreaks.length === 0) return null;

	const screened = ctx ? screenedLine(ctx, context.ranking) : null;
	const subLine = setBonusSubLine(ctx ?? { singleBreaks: ownBreaks }, on) ?? (screened ? 'hover_hint' : null);
	if (subLine === null) return null;

	const potential = ctx && on && (ctx.futureBonuses ?? []).length > 0 ? potentialLines(ctx, cutoff, credit) : NO_POTENTIAL;
	if (ctx && potential.kind === 'outcomes') return { subLine, kind: 'outcomes', entries: outcomesEntries(row, ctx, potential.lines, bar) };

	const singleBreaks = ctx ? (ctx.singleBreaks ?? []) : ownBreaks;
	const measuredBreaks = singleBreaks.flatMap(b => (b.dps === undefined ? [] : [{ ...b, dps: b.dps }]));
	const unmeasuredBreaks = singleBreaks.filter(b => b.dps === undefined).map(ref);
	// The `??` cannot fire while crossesThreshold is true; it keeps the count a number.
	const bonus = ctx?.crossesThreshold ? { setName: ctx.setName, threshold: crossingLabelCount(ctx) ?? ctx.piecesAfterSwap } : undefined;
	const total = row.deltaDps + credit;
	const breakTenths = measuredBreaks.map(b => tenthsOf(-b.dps));
	const firstTenths = shownTenths(row.deltaDps, bar) - breakTenths.reduce((a, b) => a + b, 0);

	const entries: TipEntry[] = [];
	// Kept even when it equals the total if it names a bonus or a loss, as no other line names them.
	if (bonus !== undefined || unmeasuredBreaks.length > 0 || firstTenths !== shownTenths(total, bar)) {
		entries.push(line({ kind: 'item_stats', ...(bonus ? { bonus } : {}), unmeasuredBreaks }, firstTenths / 10));
	}
	measuredBreaks.forEach((b, i) => entries.push(line({ kind: 'breaks', broken: [ref(b)] }, breakTenths[i]! / 10)));

	if (potential.kind !== 'none') entries.push({ type: 'heading', heading: 'set_potential' });
	if (potential.kind === 'unmeasured') {
		for (const l of potential.lines) entries.push(line(l.label, undefined));
	} else if (potential.kind === 'itemised' || potential.kind === 'steps') {
		// The toggle-off lines add up to the toggle-off figure, so these must add up to the difference.
		const shown = spreadTenths(
			potential.lines.map(l => l.dps ?? 0),
			shownTenths(total, bar) - shownTenths(row.deltaDps, bar),
		);
		potential.lines.forEach((l, i) => entries.push(line(l.label, shown[i]! / 10)));
	}

	// What the figure does not count goes after the total, so the toggle never decides whether the popover exists.
	const notCounted: TipEntry[] = [];
	if (ctx && cutoff !== undefined) {
		const pastStop = on && potential.stopThreshold !== undefined;
		const reachable = !on || potential.kind === 'none' || pastStop ? reachableLines(row, ctx, cutoff, potential.stopThreshold) : [];
		const section = [...reachable, ...(screened ? [screened] : []), ...noiseLines(ctx, cutoff)];
		// "No gain over the item alone" would misstate a step past `stopThreshold`, which is measured against that step.
		if (section.length > 0) notCounted.push({ type: 'heading', heading: notCountedHeading(reachable.length > 0 && !pastStop, on) }, ...section);
	}
	if (entries.length === 0 && notCounted.length === 0) return null;
	entries.push(line({ kind: 'total' }, shownValue(total, bar)), ...notCounted);
	return { subLine, kind: 'receipt', entries };
}
