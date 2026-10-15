/**
 * The set-bonus popover of a result row, as data (tickets 431, 467, 494, 517,
 * ported from the old tab's `setBonusPresentation`, cb561067
 * `upgrades_tab.tsx`). A receipt whose lines add up to the row's figure, so
 * the reader sees where the number came from; or, for a step ranking row
 * whose partner sets do not nest (K6), separate outcomes that are not a sum.
 * `utils/set_bonus_labels.ts` turns it into text.
 */

import { setBonusNoiseFloorDps } from './engine/cutoff';
import type { RankedItem, Ranking, SetContext } from './engine/rank';
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
	singleSwapBreaks,
	stepEligible,
	stepFutureUnmeasured,
} from './engine/view';

/** A set bonus as a label names it: "{set} {count}pc". */
export type BonusRef = { setName: string; threshold: number };

export type TipLabel =
	/** The row's own stats; names the bonus it crosses and the worn bonuses it breaks unmeasured, whose value it then includes. */
	| { kind: 'item_stats'; bonus?: BonusRef; unmeasuredBreaks: BonusRef[] }
	| { kind: 'breaks'; broken: BonusRef[] }
	| { kind: 'bonus'; set: string; threshold: number; have: number }
	| { kind: 'piece_stats'; name: string }
	/** A step ranking line: the partner pieces, the bonus they reach and the worn bonuses lost. */
	| { kind: 'pieces'; form: 'stop' | 'step'; pieces: string[]; threshold: number; broken: BonusRef[] }
	| { kind: 'item_alone'; name: string; broken: BonusRef[] }
	/** A bonus the row can reach that its figure does not count: the partner pieces and the worn bonuses the step breaks beyond the row's own (ticket 336). */
	| { kind: 'reachable'; set: string; threshold: number; have: number; pieces: string[]; broken: BonusRef[] }
	/** A set the set screen dropped (ADR-0035), so no bonus of it was measured for the row. */
	| { kind: 'screened'; set: string; reason: ScreenedReason }
	| { kind: 'total' };

export type ScreenedReason = Extract<ScreenReason, 'outside-band' | 'exact-zero' | 'below-zero'>;

/**
 * `dps` undefined is a figure that was not measured. In a receipt every line
 * above the total is already rounded to tenths so the lines add up to the
 * total as shown; `marker` names the outcome the row's figure uses; `outcome`
 * marks a line after the total that is compared with the item alone and added
 * to nothing.
 */
export type TipEntry =
	| { type: 'heading'; heading: 'set_potential' | 'set_potential_totals' | 'not_counted_off' | 'not_counted_no_gain' | 'not_counted' }
	| { type: 'line'; label: TipLabel; dps: number | undefined; marker?: true; outcome?: true };

export type SetBonusTip = { subLine: 'hover_hint' | 'not_counted'; kind: 'receipt' | 'outcomes'; entries: TipEntry[] };

export type SetBonusTipContext = {
	/** Absent while a run is in flight: no cutoff yet, so no set potential and no own-swap breaks. */
	ranking?: Pick<Ranking, 'cutoff' | 'brokenSetValues' | 'setBonuses' | 'setScreen'>;
	/** The gear the ranking was measured on, in sim slot order. */
	wornItemIds?: readonly number[];
	specId?: SpecId;
	/** The Set potential toggle; P3 brings the control. */
	withSetPotential?: boolean;
};

type Line = { label: TipLabel; dps: number | undefined; figure?: boolean };

/** A figure in tenths of a DPS, rounded the way the popover shows it. */
const tenths = (v: number): number => Math.round(Number(v.toFixed(1)) * 10);

/**
 * Rounds `values` to tenths so they add up to exactly `target` tenths, moving
 * the fewest lines by one tenth each (largest remainder). Rounding each line
 * alone can leave the shown lines a tenth off their shown total.
 */
export function spreadTenths(values: readonly number[], target: number): number[] {
	const out = values.map(tenths);
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

type Potential = { lines: Line[]; kind: 'unmeasured' | 'none' | 'itemised' | 'steps' | 'outcomes' };
const NO_POTENTIAL: Potential = { lines: [], kind: 'none' };

/**
 * The Set potential section of a row with future bonuses, with the toggle on:
 * `unmeasured` names each figure the credit lacks; `none` when the credit is
 * 0; `itemised` the credit's terms (ticket 502); `steps` a step ranking's
 * steps up to the stop, which add up to the credit (K6, K6B); `outcomes` a
 * step ranking whose partner sets do not nest, one total per bonus.
 */
function potentialLines(ctx: SetContext, noiseFloorDps: number, credit: number): Potential {
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
		const steps = setPotentialSteps(ctx, noiseFloorDps);
		if (steps !== null) {
			const lines = steps.flatMap((s): Line[] =>
				s.breaksLineDps === undefined || s.piecesLineDps === undefined
					? [{ label: piecesLine('step', s), dps: s.dps }]
					: [
							{ label: { kind: 'breaks', broken: s.broken.map(ref) }, dps: s.breaksLineDps },
							{ label: piecesLine('step', { ...s, broken: [] }), dps: s.piecesLineDps },
						],
			);
			return { lines, kind: 'steps' };
		}
		const lines = setPotentialTerms(ctx, noiseFloorDps)
			.terms.filter((term): term is Extract<SetPotentialTerm, { kind: 'stop' }> => term.kind === 'stop')
			.map(term => ({ label: piecesLine('stop', term), dps: term.totalDps, figure: term.isStop }));
		return { lines, kind: 'outcomes' };
	}
	const lines = setPotentialTerms(ctx, noiseFloorDps).terms.map((term): Line => {
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
 * The bonuses a row can reach, each as a separate outcome: the row with its
 * partner pieces against the row alone, naming the worn bonuses that step
 * breaks beyond the row's own swap, which the receipt already prices. Only the
 * futures the step rule can stop at (`stepEligible`, ticket 511), so a bonus
 * within the noise is never shown as a figure. Only a step ranking measures the
 * row with its partner pieces; elsewhere a future's figure is the bonus's own
 * value, which a label naming pieces and breaks would misstate.
 */
function reachableLines(row: RankedItem, ctx: SetContext, noiseFloorDps: number): TipEntry[] {
	if (!ctx.stepRanking) return [];
	const own = new Set((ctx.singleBreaks ?? []).map(bonusKey));
	const single = ctx.singleDeltaDps ?? row.deltaDps;
	return [...(ctx.futureBonuses ?? [])]
		.sort((a, b) => a.threshold - b.threshold)
		.filter(f => stepEligible(f, noiseFloorDps))
		.map((f): TipEntry => ({
			type: 'line',
			label: {
				kind: 'reachable',
				set: ctx.setName,
				threshold: f.threshold,
				have: ctx.piecesWornBefore,
				pieces: (f.pieces ?? []).map(p => p.name),
				broken: (f.breaks ?? []).filter(b => !own.has(bonusKey(b))).map(ref),
			},
			dps: f.stepGearDps === undefined ? undefined : f.stepGearDps - single,
			outcome: true,
		}));
}

const SCREENED_REASONS: readonly ScreenedReason[] = ['outside-band', 'exact-zero', 'below-zero'];

/**
 * The line for a row whose set the set screen dropped, or null. It carries no
 * figure: a `below-zero` measure is the pieces and the bonus together, so
 * printing it as the bonus would credit the pieces' loss to it (Gate B M1 of
 * stage tab-set-bonus).
 */
function screenedLine(ctx: SetContext, ranking: SetBonusTipContext['ranking']): TipEntry | null {
	if (!ranking?.setBonuses?.some(b => b.setId === ctx.setId && b.unmeasured === 'screened-out')) return null;
	const screen = ranking.setScreen?.mode === 'on' ? ranking.setScreen.sets.find(s => s.setId === ctx.setId) : undefined;
	// With no screen entry to read, "not measured" is the one value that is still true.
	const reason = SCREENED_REASONS.find(r => r === screen?.reason) ?? 'outside-band';
	return line({ kind: 'screened', set: ctx.setName, reason }, undefined);
}

/**
 * Each line is a separate outcome compared with the current gear (the owner's
 * ruling of 2026-10-01), so there is no Item stats addend and no total. On a
 * row paired replication rewrote, every bonus's total moves by the same amount
 * as the row's single swap, so the item-alone line and the marked line equal
 * the figures the row shows.
 */
function outcomesEntries(row: RankedItem, ctx: SetContext, outcomes: readonly Line[]): TipEntry[] {
	const shift = row.deltaDps - (ctx.singleDeltaDps ?? row.deltaDps);
	return [
		{ type: 'heading', heading: 'set_potential_totals' },
		line({ kind: 'item_alone', name: row.name, broken: (ctx.singleBreaks ?? []).map(ref) }, row.deltaDps),
		...outcomes.map(o => line(o.label, (o.dps ?? 0) + shift, o.figure)),
	];
}

/**
 * The popover of `row`, or null when it has nothing to say. The first "Item
 * stats" line balances the toggle-off receipt and keeps its value when the
 * toggle changes, so the toggle's rounding goes into the Set potential lines.
 * A plain "Item stats" line equal to the total only repeats the cell, so it is
 * dropped, and a row left with only the total gets no popover (ticket 517).
 */
export function setBonusTipLines(row: RankedItem, context: SetBonusTipContext = {}): SetBonusTip | null {
	const ctx = row.setContext;
	const noiseFloorDps = context.ranking ? setBonusNoiseFloorDps(context.ranking.cutoff) : undefined;
	const on = (context.withSetPotential ?? false) && noiseFloorDps !== undefined;
	const credit = on ? rankableSetPotential(row, noiseFloorDps, 'full') : 0;
	// A row with no set context gets the same receipt for the worn bonuses its own swap breaks (ticket 536).
	const ownBreaks =
		ctx || !context.ranking || !context.specId ? [] : singleSwapBreaks(row, context.ranking.brokenSetValues, context.wornItemIds, context.specId);
	if (!ctx && ownBreaks.length === 0) return null;

	const screened = ctx ? screenedLine(ctx, context.ranking) : null;
	const subLine = setBonusSubLine(ctx ?? { singleBreaks: ownBreaks }, on) ?? (screened ? 'hover_hint' : null);
	if (subLine === null) return null;

	const potential = ctx && on && (ctx.futureBonuses ?? []).length > 0 ? potentialLines(ctx, noiseFloorDps, credit) : NO_POTENTIAL;
	if (ctx && potential.kind === 'outcomes') return { subLine, kind: 'outcomes', entries: outcomesEntries(row, ctx, potential.lines) };

	const singleBreaks = ctx ? (ctx.singleBreaks ?? []) : ownBreaks;
	const measuredBreaks = singleBreaks.flatMap(b => (b.dps === undefined ? [] : [{ ...b, dps: b.dps }]));
	const unmeasuredBreaks = singleBreaks.filter(b => b.dps === undefined).map(ref);
	// The `??` cannot fire while crossesThreshold is true; it keeps the count a number.
	const bonus = ctx?.crossesThreshold ? { setName: ctx.setName, threshold: crossingLabelCount(ctx) ?? ctx.piecesAfterSwap } : undefined;
	const total = row.deltaDps + credit;
	const breakTenths = measuredBreaks.map(b => tenths(-b.dps));
	const firstTenths = tenths(row.deltaDps) - breakTenths.reduce((a, b) => a + b, 0);

	const entries: TipEntry[] = [];
	// A folded label is kept even when it equals the total: it is the only place that bonus is named.
	if (bonus !== undefined || unmeasuredBreaks.length > 0 || firstTenths !== tenths(total)) {
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
			tenths(total) - tenths(row.deltaDps),
		);
		potential.lines.forEach((l, i) => entries.push(line(l.label, shown[i]! / 10)));
	}

	// What the figure does not count, after the total, so the toggle never decides whether the popover exists (ticket 336).
	const notCounted: TipEntry[] = [];
	if (ctx && noiseFloorDps !== undefined) {
		const reachable = on && potential.kind !== 'none' ? [] : reachableLines(row, ctx, noiseFloorDps);
		const section = [...reachable, ...(screened ? [screened] : [])];
		if (section.length > 0) {
			// The toggle is never why a screened set is not counted, so a section of only that line names no reason.
			const heading = reachable.length === 0 ? 'not_counted' : on ? 'not_counted_no_gain' : 'not_counted_off';
			notCounted.push({ type: 'heading', heading }, ...section);
		}
	}
	if (entries.length === 0 && notCounted.length === 0) return null;
	entries.push(line({ kind: 'total' }, total), ...notCounted);
	return { subLine, kind: 'receipt', entries };
}
