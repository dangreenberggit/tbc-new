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
	| { kind: 'total' };

/**
 * `dps` undefined is a figure that was not measured. In a receipt every line
 * but the total is already rounded to tenths so the lines add up to the total
 * as shown; `marker` names the outcome the row's figure uses.
 */
export type TipEntry =
	| { type: 'heading'; heading: 'set_potential' | 'set_potential_totals' }
	| { type: 'line'; label: TipLabel; dps: number | undefined; marker?: true };

export type SetBonusTip = { subLine: 'hover_hint' | 'not_counted'; kind: 'receipt' | 'outcomes'; entries: TipEntry[] };

export type SetBonusTipContext = {
	/** Absent while a run is in flight: no cutoff yet, so no set potential and no own-swap breaks. */
	ranking?: Pick<Ranking, 'cutoff' | 'brokenSetValues'>;
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

	const subLine = setBonusSubLine(ctx ?? { singleBreaks: ownBreaks }, on);
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
	if (entries.length === 0) return null;
	entries.push(line({ kind: 'total' }, total));
	return { subLine, kind: 'receipt', entries };
}
