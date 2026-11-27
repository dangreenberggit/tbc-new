/**
 * `measureWornSets` gives `wornSetLadder`: what each piece count of a worn set is worth,
 * measured on the worn gear. `countsAsBreakFrom` counts a swap as breaking only a count that
 * ladder counted. `wornSetValues` gives the set phase both, with `brokenSetValues`.
 */

import type { RunNote } from './disclosure';
import type { BrokenSetValue, WornSetCountEntry } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusCountsSkipNote, wornSetSkipNote } from './run-notes';
import type { RaidSimRequest } from './seams/sim-runner';
import { applySetLessCopies, clearsSameGearNoise, errorText, measureWornSetCounts } from './set-less-copies';
import type { SampleRunnerFor, SetPhaseContext } from './set-phase';
import { bonusCountOf, bonusKey, type BrokenSetBonus, type CountsAsBreak, isBonusImplemented, setCounts, setNameOf, setPieceSlots } from './set-value';
import { StopRefusedSim } from './sim-calls';

/**
 * The value of each piece count of every set worn at 2 or more pieces
 * (`measureWornSetCounts`), in set-id order. A count is `counted` when its
 * value is above noise. A count whose sim failed is `counted` only when the
 * sim's list of the set's bonuses (`readBonuses`) has it, so no count without
 * a bonus becomes a loss. When that list fails too, no failed count is
 * counted, and the lines say what was not measured. A runner with no list
 * gives no such line, so there a failed count is counted.
 */
export async function measureWornSets(
	ctx: SetPhaseContext,
	cachedSampleRun: SampleRunnerFor,
	readBonuses?: (request: RaidSimRequest) => Promise<readonly string[]>,
): Promise<WornSetCountEntry[]> {
	const { equipment, composeFor, cutoff, setCheckNotes } = ctx;
	const worn = [...setCounts(equipment)]
		.filter(([, count]) => count >= 2)
		.map(([setId]) => setId)
		.sort((a, b) => a - b);
	if (worn.length === 0) return [];
	const request = composeFor(equipment);
	const entries: WornSetCountEntry[] = [];
	for (const setId of worn) {
		const setName = setNameOf(equipment, setId);
		const slots = setPieceSlots(equipment, setId);
		const countValues = await measureWornSetCounts(cachedSampleRun(`${setName} worn-set counts`), request, slots, (error, notBuilt) =>
			setCheckNotes.push(
				wornSetSkipNote({
					setName,
					error,
					...(notBuilt ? { notBuilt } : {}),
				}),
			),
		);
		const bonusCounts =
			readBonuses && countValues.some(countValue => countValue.unmeasured !== undefined)
				? await wornSetBonusCounts(readBonuses, request, slots, setName, setCheckNotes)
				: undefined;
		for (const countValue of countValues) {
			const counted =
				countValue.unmeasured !== undefined
					? (bonusCounts?.has(countValue.count) ?? true)
					: countValue.dps !== undefined && clearsSameGearNoise(countValue.dps, countValue.se ?? 0, cutoff);
			entries.push({ setId, setName, ...countValue, counted });
		}
	}
	return entries;
}

/**
 * The counts at which a worn set has a bonus, as the sim lists them: the
 * bonuses active on the worn gear that go when the set's pieces are sent as
 * set-less copies. Empty when a read fails, with a line that gives its error;
 * undefined when Stop refused the read.
 */
async function wornSetBonusCounts(
	readBonuses: (request: RaidSimRequest) => Promise<readonly string[]>,
	request: RaidSimRequest,
	slots: readonly number[],
	setName: string,
	notes: RunNote[],
): Promise<ReadonlySet<number> | undefined> {
	let setLess: RaidSimRequest;
	try {
		setLess = applySetLessCopies(request, slots);
	} catch (err) {
		console.warn(`[upgrades] ${setName}: its bonus counts were not read`, err);
		notes.push(
			setBonusCountsSkipNote({
				setName,
				reason: SET_BONUS_SKIP_REASONS.bonusListNotBuilt(errorText(err)),
			}),
		);
		return new Set();
	}
	try {
		const worn = await readBonuses(request);
		const left = new Set(await readBonuses(setLess));
		const counts = new Set<number>();
		for (const name of worn) {
			if (left.has(name)) continue;
			const count = bonusCountOf(name);
			if (count !== undefined) counts.add(count);
		}
		return counts;
	} catch (err) {
		if (err instanceof StopRefusedSim) return undefined;
		console.warn(`[upgrades] ${setName}: its bonus counts were not read`, err);
		notes.push(
			setBonusCountsSkipNote({
				setName,
				reason: SET_BONUS_SKIP_REASONS.bonusListFailed(errorText(err)),
			}),
		);
		return new Set();
	}
}

/** With `measureSetBonuses`, a swap loses only counts `wornSetLadder` counted. */
export function countsAsBreakFrom(wornSetCounts: readonly WornSetCountEntry[]): CountsAsBreak {
	const counted = new Set(wornSetCounts.filter(e => e.counted).map(e => `${e.setId}:${e.count}`));
	return (setId, count) => counted.has(`${setId}:${count}`);
}

/**
 * Each counted worn bonus's measured DPS by `bonusKey`, undefined when its
 * sim failed. Built once per set phase from `brokenSetValues`, for every
 * reader of a lost bonus's value.
 */
export function brokenBonusDpsByKey(brokenSetValues: readonly BrokenSetValue[]): Map<string, number | undefined> {
	const byKey = new Map<string, number | undefined>();
	for (const v of brokenSetValues) byKey.set(bonusKey(v), v.dps);
	return byKey;
}

/** A lost bonus as a row shows it: the bonus, with its measured DPS when there is one. */
export function brokenBonusWithDps(brk: BrokenSetBonus, dpsByKey: ReadonlyMap<string, number | undefined>) {
	const dps = dpsByKey.get(bonusKey(brk));
	return {
		setId: brk.setId,
		setName: brk.setName,
		threshold: brk.threshold,
		...(dps !== undefined ? { dps } : {}),
	};
}

/**
 * The worn sets' values, and what the rest of the set phase reads from them:
 * which lost counts are breaks, and the counted ones as `brokenSetValues`
 * with their DPS by `bonusKey`.
 */
export async function wornSetValues(
	ctx: SetPhaseContext,
	cachedSampleRun: SampleRunnerFor,
): Promise<{
	wornSetLadder: WornSetCountEntry[];
	countsAsBreak: CountsAsBreak;
	brokenSetValues: BrokenSetValue[];
	brokenBonusDpsByKey: Map<string, number | undefined>;
}> {
	const { deps, measureSetBonuses } = ctx;
	// The value of every bonus each worn set has, on the player's own gear,
	// before any reachable bonus is simmed, so every loss below reads a
	// measured value instead of a table. It runs even when no set piece is a
	// candidate, because a candidate from no set can still break a worn set,
	// and the set-bonus popover prices that break from `brokenSetValues`.
	const wornSetLadder = measureSetBonuses
		? await measureWornSets(ctx, cachedSampleRun, deps.sim.activeSetBonuses ? request => deps.sim.activeSetBonuses!(request) : undefined)
		: [];
	const countsAsBreak: CountsAsBreak = measureSetBonuses ? countsAsBreakFrom(wornSetLadder) : isBonusImplemented;
	const brokenSetValues: BrokenSetValue[] = wornSetLadder
		.filter(e => e.counted)
		.sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.count - a.count))
		.map(e => ({
			setId: e.setId,
			setName: e.setName,
			threshold: e.count,
			...(e.dps !== undefined ? { dps: e.dps } : {}),
			...(e.se !== undefined ? { se: e.se } : {}),
			...(e.unmeasured ? { unmeasured: e.unmeasured } : {}),
		}));
	return { wornSetLadder, countsAsBreak, brokenSetValues, brokenBonusDpsByKey: brokenBonusDpsByKey(brokenSetValues) };
}
