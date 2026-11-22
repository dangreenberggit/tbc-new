/**
 * The value of completing a set bonus: which pieces to add, and the bonus left after their
 * own value is taken out. Pure functions, no sims.
 */

import { getItem } from './items';
import type { PoolEntry } from './pool';
import type { SimObservation } from './seams/sim-runner';
import type { SimItemSpec } from './slots';

/**
 * A piece count of 2 or more at which a set may have a bonus. A plain number, not a union:
 * the Go sim keys bonuses at whatever counts a set defines (3, 6, 8), and every count a
 * swap loses is measured.
 */
export type SetThreshold = number;

/**
 * The counts tried when completing a set, and the counts checked for a lost bonus with
 * `isBonusImplemented` when `measureSetBonuses` is off.
 */
export const SET_THRESHOLDS: readonly SetThreshold[] = [2, 4];

/**
 * Whether losing `setId`'s `count`-piece bonus counts as a break: `isBonusImplemented` by
 * default, or with `measureSetBonuses`, whether `measureWornSetCounts` measured that
 * bonus above noise.
 */
export type CountsAsBreak = (setId: number, count: number) => boolean;

export type UnmeasuredReason =
	| 'not-implemented-in-sim'
	| 'insufficient-pieces'
	| 'sim-failed'
	| 'repair-failed'
	| 'unmeasurable-at-this-worn-count'
	/**
	 * The set screen dropped the set. Kept for saved rankings that carry it; a dropped set
	 * now has no entry and `ranking.setScreen` records it.
	 */
	| 'screened-out';

/**
 * Which (setId, threshold) bonuses a ranking without `measureSetBonuses` measures; with
 * it, every lost count is measured by `measureWornSetCounts`. Do not extend this table:
 * the tab keeps no list of implemented set bonuses.
 */
const IMPLEMENTED_IN_SIM: Record<number, Partial<Record<SetThreshold, boolean>>> = {
	// Justicar 2pc only scales Judgement of the Crusader (sim/paladin/seals.go), which the
	// default ret APL casts only before the pull, so it is treated as near 0 DPS.
	626: { 2: false, 4: true }, // Justicar Battlegear
	629: { 2: true, 4: true }, // Crystalforge Battlegear
	680: { 2: true, 4: true }, // Lightbringer Battlegear
	640: { 2: true, 4: true }, // Malorne Harness
	641: { 2: false, 4: true }, // Nordrassil Harness
	676: { 2: true, 4: true }, // Thunderheart Harness
};

/** The set ids the table above covers, for tests that pin facts per set. */
export const IMPLEMENTED_SET_IDS: readonly number[] = Object.keys(IMPLEMENTED_IN_SIM).map(Number);

export function isBonusImplemented(setId: number, threshold: SetThreshold): boolean {
	return IMPLEMENTED_IN_SIM[setId]?.[threshold] ?? false;
}

export function setCounts(equipment: readonly SimItemSpec[]): Map<number, number> {
	const counts = new Map<number, number>();
	for (const spec of equipment) {
		if (!spec.id) continue;
		const setId = getItem(spec.id)?.setId;
		if (setId == null) continue;
		counts.set(setId, (counts.get(setId) ?? 0) + 1);
	}
	return counts;
}

/** The slots of `equipment` that hold a piece of `setId`, in slot order. */
export function setPieceSlots(equipment: readonly SimItemSpec[], setId: number): number[] {
	return equipment.flatMap((spec, i) => (spec.id && getItem(spec.id)?.setId === setId ? [i] : []));
}

/**
 * The piece count in the name of a bonus the sim lists (`<set> (<n>pc)`), or
 * undefined for a name without one.
 */
export function bonusCountOf(bonusName: string): number | undefined {
	const match = / \((\d+)pc\)$/.exec(bonusName);
	return match ? Number(match[1]) : undefined;
}

export function setNameOf(equipment: readonly SimItemSpec[], setId: number, moreItemIds: readonly number[] = []): string {
	for (const spec of equipment) {
		if (!spec.id) continue;
		const item = getItem(spec.id);
		if (item?.setId === setId && item.setName) return item.setName;
	}
	for (const itemId of moreItemIds) {
		const item = getItem(itemId);
		if (item?.setId === setId && item.setName) return item.setName;
	}
	return `set ${setId}`;
}

export function nextImplementedThreshold(setId: number, piecesAfterSwap: number): SetThreshold | null {
	for (const t of SET_THRESHOLDS) {
		if (t <= piecesAfterSwap) continue;
		if (isBonusImplemented(setId, t)) return t;
	}
	return null;
}

/** An item put into one sim slot of current gear. */
export type PlacedItem = {
	itemId: number;
	slotIndex: number;
};

export type AddedPiecesResult = { ok: true; piecesWorn: number; addedPieces: PlacedItem[] } | { ok: false; reason: 'insufficient-pieces' };

/**
 * One item's own DPS change, used to pick the pieces that complete a set and to take their
 * value out of the gain of wearing them together. `deltaDps` must be candidate minus
 * baseline from the same run, so the offset both readings share cancels in
 * `computeBonusDps`; moving it onto another baseline would bring the offset back.
 */
export type OwnDelta = {
	itemId: number;
	slotIndex: number;
	deltaDps: number;
	se: number;
};

export function selectAddedPieces(
	setId: number,
	threshold: SetThreshold,
	equipment: readonly SimItemSpec[],
	poolCandidates: readonly PoolEntry[],
	ownDeltas: readonly OwnDelta[],
	slotIndexForPoolEntry: (entry: PoolEntry) => number | undefined,
): AddedPiecesResult {
	const wornSlotIndices = new Set<number>();
	let piecesWorn = 0;
	for (let i = 0; i < equipment.length; i++) {
		const spec = equipment[i];
		if (!spec?.id) continue;
		if (getItem(spec.id)?.setId === setId) {
			piecesWorn++;
			wornSlotIndices.add(i);
		}
	}

	const needed = threshold - piecesWorn;
	if (needed <= 0) {
		return { ok: true, piecesWorn, addedPieces: [] };
	}

	const deltaByItemId = new Map(ownDeltas.map(d => [d.itemId, d] as const));

	const bestPerSlot = new Map<number, OwnDelta & { itemId: number }>();
	for (const entry of poolCandidates) {
		const item = getItem(entry.itemId);
		if (item?.setId !== setId) continue;
		const slotIndex = slotIndexForPoolEntry(entry);
		if (slotIndex === undefined) continue;
		if (wornSlotIndices.has(slotIndex)) continue;
		const delta = deltaByItemId.get(entry.itemId);
		if (!delta) continue;

		const current = bestPerSlot.get(slotIndex);
		if (!current || delta.deltaDps > current.deltaDps || (delta.deltaDps === current.deltaDps && delta.itemId < current.itemId)) {
			bestPerSlot.set(slotIndex, delta);
		}
	}

	const candidates = [...bestPerSlot.values()].sort((a, b) => (b.deltaDps !== a.deltaDps ? b.deltaDps - a.deltaDps : a.itemId - b.itemId));

	if (candidates.length < needed) {
		return { ok: false, reason: 'insufficient-pieces' };
	}

	const addedPieces: PlacedItem[] = candidates
		.slice(0, needed)
		.map(c => ({
			itemId: c.itemId,
			slotIndex: c.slotIndex,
		}))
		.sort((a, b) => a.slotIndex - b.slotIndex);

	return { ok: true, piecesWorn, addedPieces };
}

export type BrokenSetBonus = {
	setId: number;
	setName: string;
	threshold: SetThreshold;
	piecesBefore: number;
	piecesAfter: number;
};

export const bonusKey = (b: { setId: number; threshold: number }): string => `${b.setId}:${b.threshold}`;

/** Lost bonus counts that `countsAsBreak` accepts, highest first; no list decides which exist. */
export function brokenThresholds(setId: number, before: number, after: number, countsAsBreak: CountsAsBreak = isBonusImplemented): SetThreshold[] {
	const broken: SetThreshold[] = [];
	for (let t = before; t > after && t >= 2; t--) {
		if (countsAsBreak(setId, t)) broken.push(t);
	}
	return broken;
}

/**
 * Every worn bonus the added pieces break, one entry per lost count `countsAsBreak` accepts,
 * sorted by `setId` then descending threshold. Taking a set from 4 to 0 loses both the
 * 4pc and the 2pc, and both are charged.
 */
export function brokenSetBonuses(
	equipment: readonly SimItemSpec[],
	addedPieces: readonly PlacedItem[],
	completingSetId: number,
	countsAsBreak: CountsAsBreak = isBonusImplemented,
): BrokenSetBonus[] {
	const before = setCounts(equipment);
	const after = new Map(before);
	for (const piece of addedPieces) {
		const displaced = equipment[piece.slotIndex]?.id;
		const displacedSetId = displaced ? getItem(displaced)?.setId : undefined;
		if (displacedSetId != null) {
			after.set(displacedSetId, (after.get(displacedSetId) ?? 0) - 1);
		}
		const addedSetId = getItem(piece.itemId)?.setId;
		if (addedSetId != null) {
			after.set(addedSetId, (after.get(addedSetId) ?? 0) + 1);
		}
	}

	const broken: BrokenSetBonus[] = [];
	for (const [setId, piecesBefore] of before) {
		if (setId === completingSetId) continue;
		const piecesAfter = after.get(setId) ?? 0;
		if (piecesAfter >= piecesBefore) continue;
		for (const threshold of brokenThresholds(setId, piecesBefore, piecesAfter, countsAsBreak)) {
			broken.push({
				setId,
				setName: setNameOf(equipment, setId),
				threshold,
				piecesBefore,
				piecesAfter,
			});
		}
	}
	return broken.sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.threshold - a.threshold));
}

/**
 * How one broken worn bonus shows up in a raw `bonusDps`, for `netInflation`. The 2pc
 * fields are 0 when the added pieces are the 2pc.
 */
export type InflationTerm = {
	piecesBreakingAlone: number;
	twoPcPiecesBreakingAlone: number;
	allPiecesBreak: number;
	allTwoPcPiecesBreak: number;
	brokenBonusDps: number;
};

/**
 * How much a raw `bonusDps` overstates the bonus because of worn bonuses the added pieces
 * break. Each broken bonus costs `brokenBonusDps` in the gain of the added pieces, in each
 * own swap and in the raw 2pc value, and `computeBonusDps` subtracts the last two. At
 * worn 4 a wrong sign on `allTwoPcPiecesBreak` gives the same answer, so it shows only at
 * other worn counts.
 */
export function netInflation(terms: readonly InflationTerm[]): number {
	return terms.reduce(
		(sum, k) => sum + (k.piecesBreakingAlone - k.twoPcPiecesBreakingAlone - k.allPiecesBreak + k.allTwoPcPiecesBreak) * k.brokenBonusDps,
		0,
	);
}

export type DpsSample = { dps: number; se: number };

/** One sim's DPS, with the standard error of its mean over `iterations`. */
export function sampleOf(observation: Pick<SimObservation, 'dps' | 'stdev'>, iterations: number): DpsSample {
	return { dps: observation.dps, se: observation.stdev / Math.sqrt(iterations) };
}

export function combineSe(samples: readonly DpsSample[]): number {
	return Math.sqrt(samples.reduce((sum, s) => sum + s.se * s.se, 0));
}

export type AddedPieceSample = {
	deltaDps: number;
	se: number;
};

export type BonusDpsInput = {
	baseline: DpsSample;
	addedPiecesSample: DpsSample;
	addedPieceSamples: readonly AddedPieceSample[];
	twoPcBonusDps?: number;
};

export type BonusDpsResult = {
	packageDeltaDps: number;
	bonusDps: number;
	se: number;
};

/** When the row's own set bonus may be inside its measured gain. */
export type SelfSetConfound = {
	threshold: SetThreshold;
	/**
	 * The value of the bonus at `threshold`, measured by simming two added pieces
	 * together, and already added back into the 4pc `bonusDps`. Absent when no two added
	 * pieces broke nothing alone and together, or that sim or its repair failed. The 4pc
	 * `bonusDps` then still has the 2pc charged once per added piece past the first, and
	 * `applyNetCorrection` (set-bonus-net.ts) leaves its `bonusDpsNet` unset.
	 */
	dps?: number;
};

export function computeBonusDps(input: BonusDpsInput): BonusDpsResult {
	const packageDeltaDps = input.addedPiecesSample.dps - input.baseline.dps;
	const sumOfOwnDeltas = input.addedPieceSamples.reduce((sum, s) => sum + s.deltaDps, 0);
	const bonusDps = packageDeltaDps - sumOfOwnDeltas - (input.twoPcBonusDps ?? 0);
	const se = combineSe([input.baseline, input.addedPiecesSample, ...input.addedPieceSamples.map(s => ({ dps: 0, se: s.se }))]);
	return { packageDeltaDps, bonusDps, se };
}
