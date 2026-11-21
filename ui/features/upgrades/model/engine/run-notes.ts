/**
 * Every sentence a run adds to "Items left out and other notes": skipped candidates and set
 * bonuses, blocked hands, meta gem preferences and the hit-cap notes. Pure text builders.
 */

import { missingMetaPreferenceNote } from './candidate-gems';
import type { RunNote } from './disclosure';
import type { SimSlotName } from './pool';
import type { SetThreshold } from './set-value';
import type { DetectedSpecId } from './types';

export function metaPreferenceNotes(spec: DetectedSpecId | undefined): RunNote[] {
	const note = missingMetaPreferenceNote(spec);
	return note ? [{ field: 'Meta gem for your spec', detail: note }] : [];
}

/**
 * One line for every one-handed weapon the worn two-hander kept out of the
 * run (`oneHandBlockedEntries`).
 */
export function oneHandBlockedNotes(count: number): RunNote[] {
	if (count === 0) return [];
	return [
		{
			field: 'One-handed weapons',
			detail:
				count === 1
					? '1 one-handed weapon was not ranked, because you wear a two-handed weapon.'
					: `${count} one-handed weapons were not ranked, because you wear a two-handed weapon.`,
		},
	];
}

/** One line for every off-hand item the worn two-hander kept out of the run. */
export function offHandBlockedNotes(count: number): RunNote[] {
	if (count === 0) return [];
	return [
		{
			field: 'Off-hand items',
			detail:
				count === 1
					? '1 off-hand item was not ranked, because you wear a two-handed weapon.'
					: `${count} off-hand items were not ranked, because you wear a two-handed weapon.`,
		},
	];
}

/** One item in one slot that the run could not price. */
export type CandidateSkip = {
	kind: 'sim' | 'repair';
	itemId: number;
	name: string;
	slot: SimSlotName;
	reason: string;
};

/**
 * A ring, trinket or one-hander is tried once per slot, so a failed try says
 * only "this slot" and carries the slot as data for the page to name: the
 * same item can still rank from its other slot.
 */
export function candidateSkipNote(skip: CandidateSkip): RunNote {
	// After the sentence, so for the console only: the page shows a line's
	// first line, and names the item and slot.
	const where = `item ${skip.itemId}, slot ${skip.slot}`;
	const line = { field: skip.name, slot: skip.slot };
	return skip.kind === 'sim'
		? {
				...line,
				detail: `This item was not ranked in this slot, because its sim failed.\n${where}`,
				error: skip.reason,
			}
		: {
				...line,
				// A gem repair that finds no recolor is no failed call (`metaOff`).
				detail: `This item was not ranked in this slot, because no gem swap could turn your meta gem on with it equipped.\n${where}: ${skip.reason}`,
			};
}

/**
 * Why a set bonus or a set was not measured: the end of the tab's sentence
 * and, when a call failed, its own error.
 */
export type SkipReason = { because: string; error?: string };

export const SET_BONUS_SKIP_REASONS = {
	simFailed: (error: string): SkipReason => ({
		because: 'its sim failed.',
		error,
	}),
	/** For a skip `onSomeRows`: the sims of those rows' gear failed. */
	rowSimsFailed: (error: string): SkipReason => ({
		because: 'their sim failed.',
		error,
	}),
	/**
	 * A gem repair that finds no recolor is no failed call, so its message follows
	 * the sentence, for the console: `error` holds only a failed call's error,
	 * which the run's error toast shows.
	 */
	metaOff: (repairMessage: string): SkipReason => ({
		because: `no gem swap could turn your meta gem on.\n${repairMessage}`,
	}),
	measuringSimsNotBuilt: {
		because: 'the sims that measure it could not be built.',
	} as SkipReason,
	notBuilt: (error: string): SkipReason => ({
		because: 'the sims that measure it could not be built.',
		error,
	}),
	/** For a skip `onSomeRows`: those rows' requests could not be built. */
	rowsNotBuilt: (error: string): SkipReason => ({
		because: 'their sims could not be built.',
		error,
	}),
	/** The request for the set's bonus list could not be built. */
	bonusListNotBuilt: (error: string): SkipReason => ({
		because: "the check that lists the set's bonuses could not be built.",
		error,
	}),
	/** The sim's list of a set's active bonuses failed. */
	bonusListFailed: (error: string): SkipReason => ({
		because: "the sim could not list the set's bonuses.",
		error,
	}),
} as const;

const withError = (line: { field: string; detail: string }, error: string | undefined): RunNote => (error === undefined ? line : { ...line, error });

/** One set bonus the set phase could not measure, for the run or `onSomeRows` only. */
export type SetBonusSkip = {
	setName: string;
	threshold: SetThreshold;
	reason: SkipReason;
	onSomeRows?: true;
};

export function setBonusSkipNote(skip: SetBonusSkip): RunNote {
	return withError(
		{
			field: `${skip.setName} ${skip.threshold}-piece set bonus`,
			detail: `The ${skip.setName} ${skip.threshold}-piece set bonus was not measured${skip.onSomeRows ? ' on some rows' : ''}, because ${skip.reason.because}`,
		},
		skip.reason.error,
	);
}

/**
 * A set whose bonus counts were not read. No count above the worn one is tried
 * for it, so its bonuses in reach get no figure; its worn bonuses are measured
 * separately, on the player's own gear (`wornSetLadder`).
 */
export function setBonusCountsSkipNote(skip: { setName: string; reason: SkipReason }): RunNote {
	return withError(
		{
			field: `${skip.setName} set`,
			detail: `The ${skip.setName} set bonuses were not all measured, because ${skip.reason.because}`,
		},
		skip.reason.error,
	);
}

/**
 * A shown bonus's bonus-off sim that failed or could not be built. The bonus
 * is still shown as one line; only its worn-bonus loss is not split out.
 */
export function breakSplitSkipNote(skip: {
	setName: string;
	threshold: SetThreshold;
	error: string;
	/** The bonus-off request could not be built, so no sim ran. */
	notBuilt?: true;
}): RunNote {
	return {
		field: `${skip.setName} ${skip.threshold}-piece set bonus`,
		detail: `On some rows, the cost of breaking the ${skip.setName} ${skip.threshold}-piece set bonus was not measured apart from the pieces that break it, because their sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * A set screen sim that failed. The screen only decides whether a set's
 * bonuses are measured at all, and a set it could not read is kept.
 */
export type SetScreenSkip = {
	setName: string;
	error: string;
	/** The check's request could not be built, so no sim ran. */
	notBuilt?: true;
};

export function setScreenSkipNote(skip: SetScreenSkip): RunNote {
	return {
		field: `${skip.setName} set`,
		detail: `The ${skip.setName} set was kept without the quick check that can skip it, because the check's sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * A worn-set value sim that failed. The line names the set and no count:
 * those sims do not know which counts hold a bonus, and a sim's piece count
 * (1 for the first) is not a count the player wears.
 */
export function wornSetSkipNote(skip: {
	setName: string;
	error: string;
	/** The sim's request could not be built, so no sim ran. */
	notBuilt?: true;
}): RunNote {
	return {
		field: `${skip.setName} set`,
		detail: `The value of the ${skip.setName} set on your gear was not fully measured, because its sim ${skip.notBuilt ? 'could not be built' : 'failed'}.`,
		error: skip.error,
	};
}

/**
 * Each note once, keyed by what the page shows: field, slot and the
 * first line of the detail. Many rows' sims can fail for one cause, and a Go
 * panic's stack trace differs from sim to sim, so a key on the whole detail
 * would repeat one sentence. The first one stays in its place, unless it has
 * no `error` and a later one does: that one takes the place, so the console
 * and the run's error toast keep the failed call's error.
 */
export function uniqueNotes(notes: readonly RunNote[]): RunNote[] {
	const placeOf = new Map<string, number>();
	const out: RunNote[] = [];
	for (const s of notes) {
		const key = `${s.field}|${s.slot ?? ''}|${s.detail.split('\n', 1)[0]}`;
		const at = placeOf.get(key);
		if (at === undefined) {
			placeOf.set(key, out.length);
			out.push(s);
		} else if (out[at]!.error === undefined && s.error !== undefined) {
			out[at] = s;
		}
	}
	return out;
}

/**
 * The hit-cap notes are written before any candidate is priced, so they say
 * "If gems were swapped": a run whose meta gem stays on swaps nothing.
 */
export function hitCapUnknownNote(): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail:
			'If gems were swapped to turn your meta gem on, hit rating was ' +
			'treated as always useful, because this tab works out the hit cap ' +
			'only when every target is level 73.',
	};
}

/**
 * The note every `fullWeight` spec gets, with or without a stats read. It
 * names no reason because the reasons differ by spec (dual wield, the
 * hunter's melee weave, a talent's hit inside the stats read for balance and
 * elemental), and the warrior page serves Arms and Fury under one spec id.
 */
export function hitCapFullWeightNote(): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail: 'If gems were swapped to turn your meta gem on, hit rating was ' + 'counted at full value, with no hit cap applied for this spec.',
	};
}

/**
 * The note a spell-hit budget gets when the player has points in a per-spell
 * hit talent: the budget leaves that talent's hit out, so the spells it covers
 * reach the cap sooner than the budget counts.
 */
export function hitCapPerSpellTalentNote(talent: string): RunNote {
	return {
		field: 'Meta gem swaps and the hit cap',
		detail:
			'If gems were swapped to turn your meta gem on, hit rating was valued ' + `as if your ${talent} talent added no hit, so it may be valued too high.`,
	};
}
