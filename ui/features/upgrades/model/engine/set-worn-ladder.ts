/**
 * `wornSetLadder` and `brokenSetValues`: what each worn set bonus is worth, measured on the
 * worn gear, and which swaps count as breaking one.
 */

import type { Cutoff } from './cutoff';
import type { RunNote } from './disclosure';
import { getItem } from './items';
import type { WornSetCountEntry } from './rank-types';
import { SET_BONUS_SKIP_REASONS, setBonusCountsSkipNote, wornSetSkipNote } from './run-notes';
import type { RaidSimRequest } from './seams/sim-runner';
import { applySetLessCopies, clearsSameGearNoise, errorText, measureWornSetCounts } from './set-less-copies';
import { type CountsAsBreak, type DpsSample, setCounts, setNameOf } from './set-value';
import { StopRefusedSim } from './sim-calls';
import type { SimItemSpec } from './slots';

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
	equipment: readonly SimItemSpec[],
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	cachedSampleRun: (what: string) => (request: RaidSimRequest) => Promise<DpsSample>,
	cutoff: Cutoff,
	notes: RunNote[],
	readBonuses?: (request: RaidSimRequest) => Promise<readonly string[]>,
): Promise<WornSetCountEntry[]> {
	const worn = [...setCounts(equipment)]
		.filter(([, count]) => count >= 2)
		.map(([setId]) => setId)
		.sort((a, b) => a - b);
	if (worn.length === 0) return [];
	const request = composeFor(equipment);
	const entries: WornSetCountEntry[] = [];
	for (const setId of worn) {
		const setName = setNameOf(equipment, setId);
		const slots = equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : []));
		const countValues = await measureWornSetCounts(cachedSampleRun(`${setName} worn-set counts`), request, slots, (error, notBuilt) =>
			notes.push(
				wornSetSkipNote({
					setName,
					error,
					...(notBuilt ? { notBuilt } : {}),
				}),
			),
		);
		const bonusCounts =
			readBonuses && countValues.some(countValue => countValue.unmeasured !== undefined)
				? await wornSetBonusCounts(readBonuses, request, slots, setName, notes)
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
			const match = / \((\d+)pc\)$/.exec(name);
			if (match) counts.add(Number(match[1]));
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
