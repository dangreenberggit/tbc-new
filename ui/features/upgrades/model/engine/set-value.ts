/** Set-bonus prospective value (completion-package synergy). Pure functions, no sims. */

import { getItem } from './items';
import type { PoolEntry } from './pool';
import type { SimItemSpec } from './slots';

/**
 * A piece count of 2 or more at which a set may have a bonus. A plain number, not a union:
 * the Go sim keys bonuses at whatever counts a set defines (3, 6, 8), and the break side
 * measures every count a swap loses.
 */
export type SetThreshold = number;

/**
 * The counts the gain side tries, and the counts the break side reads with
 * `isBonusImplemented` when `measureBrokenSetValue` is off.
 */
export const SET_THRESHOLDS: readonly SetThreshold[] = [2, 4];

/**
 * Whether losing `setId`'s `count`-piece bonus counts as a break: `isBonusImplemented` by
 * default, or the worn-set ladder's gated measurement with `measureBrokenSetValue`.
 */
export type BonusCountPredicate = (setId: number, count: number) => boolean;

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
 * Which (setId, threshold) bonuses a ranking without `measureBrokenSetValue` measures; with
 * it, the worn-set ladder measures every lost count. Do not extend this table: the tab
 * keeps no list of implemented set bonuses.
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

export function setLabel(equipment: readonly SimItemSpec[], setId: number, alsoConsider: readonly number[] = []): string {
	for (const spec of equipment) {
		if (!spec.id) continue;
		const item = getItem(spec.id);
		if (item?.setId === setId && item.setName) return item.setName;
	}
	for (const itemId of alsoConsider) {
		const item = getItem(itemId);
		if (item?.setId === setId && item.setName) return item.setName;
	}
	return `set ${setId}`;
}

export function nextMeasurableThreshold(setId: number, piecesAfterSwap: number): SetThreshold | null {
	for (const t of SET_THRESHOLDS) {
		if (t <= piecesAfterSwap) continue;
		if (isBonusImplemented(setId, t)) return t;
	}
	return null;
}

export type PackagePiece = {
	itemId: number;
	slotIndex: number;
};

export type PackageSelectionResult = { ok: true; piecesWorn: number; addedPieces: PackagePiece[] } | { ok: false; reason: 'insufficient-pieces' };

/**
 * One item's own DPS delta, used to pick a set package's pieces and to subtract their
 * value from the package's gain. `deltaDps` must be candidate minus baseline from the same
 * run, so `computeSynergy`'s subtraction cancels the run's offset; re-basing it onto
 * another baseline would bring that offset back.
 */
export type IndividualDelta = {
	itemId: number;
	slotIndex: number;
	deltaDps: number;
	se: number;
};

export function selectPackage(
	setId: number,
	threshold: SetThreshold,
	equipment: readonly SimItemSpec[],
	poolCandidates: readonly PoolEntry[],
	individualDeltas: readonly IndividualDelta[],
	slotIndexForPoolEntry: (entry: PoolEntry) => number | undefined,
): PackageSelectionResult {
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

	const deltaByItemId = new Map(individualDeltas.map(d => [d.itemId, d] as const));

	const bestPerSlot = new Map<number, IndividualDelta & { itemId: number }>();
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

	const addedPieces: PackagePiece[] = candidates
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

/** The map key of one worn bonus: its set and its count. */
export const bonusKey = (b: { setId: number; threshold: number }): string => `${b.setId}:${b.threshold}`;

/**
 * The counts t of `setId` with `before ≥ t > after` and t ≥ 2 that `counts` accepts,
 * highest first. Every count in the range is tried; no list decides which exist.
 */
export function lostThresholds(setId: number, before: number, after: number, counts: BonusCountPredicate = isBonusImplemented): SetThreshold[] {
	const lost: SetThreshold[] = [];
	for (let t = before; t > after && t >= 2; t--) {
		if (counts(setId, t)) lost.push(t);
	}
	return lost;
}

/**
 * Every worn bonus the added pieces break, one entry per lost count `counts` accepts,
 * sorted by `setId` then descending threshold. Taking a set from 4 to 0 loses both the
 * 4pc and the 2pc, and both count in the net.
 */
export function brokenSetBonuses(
	equipment: readonly SimItemSpec[],
	addedPieces: readonly PackagePiece[],
	completingSetId: number,
	counts: BonusCountPredicate = isBonusImplemented,
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
		for (const threshold of lostThresholds(setId, piecesBefore, piecesAfter, counts)) {
			broken.push({
				setId,
				setName: setLabel(equipment, setId),
				threshold,
				piecesBefore,
				piecesAfter,
			});
		}
	}
	return broken.sort((a, b) => (a.setId !== b.setId ? a.setId - b.setId : b.threshold - a.threshold));
}

/**
 * One broken worn bonus's counts inside a package's raw synergy, for
 * `netInflation`. `membersPkg` / `members2pc`: how many members of this package
 * / of the same set's 2pc package break it by their own single swap.
 * `pkgEnd` / `twoPcEnd`: 1 if this package's / the 2pc package's end state
 * breaks it. The 2pc fields are 0 when the package is itself the 2pc.
 */
export type InflationKey = {
	membersPkg: number;
	members2pc: number;
	pkgEnd: number;
	twoPcEnd: number;
	B: number;
};

/**
 * How much a package's raw `bonusDps` overstates its bonus because of worn bonuses it
 * breaks: `Σ (membersPkg − members2pc − pkgEnd + twoPcEnd)·B`, the −B each broken bonus
 * puts in `pkgΔ`, the singles and the raw 2pc that `computeSynergy` subtracts. At worn 4
 * a wrong sign on `twoPcEnd` gives the same answer; it shows only at other worn counts.
 */
export function netInflation(keys: readonly InflationKey[]): number {
	return keys.reduce((sum, k) => sum + (k.membersPkg - k.members2pc - k.pkgEnd + k.twoPcEnd) * k.B, 0);
}

export type DpsSample = { dps: number; se: number };

export function combineSe(samples: readonly DpsSample[]): number {
	return Math.sqrt(samples.reduce((sum, s) => sum + s.se * s.se, 0));
}

export type AddedPieceSample = {
	deltaDps: number;
	se: number;
};

export type SynergyInput = {
	baseline: DpsSample;
	packageSample: DpsSample;
	addedPieceSamples: readonly AddedPieceSample[];
	twoPieceBonus?: number;
};

export type SynergyResult = {
	packageDeltaDps: number;
	bonusDps: number;
	se: number;
};

export type SelfSetConfound = {
	threshold: SetThreshold;
	/**
	 * The confounding threshold's own value, measured by one pair sim and already added
	 * back into the 4pc `bonusDps`. Absent when no two package pieces were break-free alone
	 * and together, or that sim or its repair failed; the 4pc `bonusDps` then keeps the
	 * `−(n−1)·B2` confound and `rank.ts` leaves its `bonusDpsNet` unset.
	 */
	dps?: number;
};

export function computeSynergy(input: SynergyInput): SynergyResult {
	const packageDeltaDps = input.packageSample.dps - input.baseline.dps;
	const sumSingles = input.addedPieceSamples.reduce((sum, s) => sum + s.deltaDps, 0);
	const bonusDps = packageDeltaDps - sumSingles - (input.twoPieceBonus ?? 0);
	const se = combineSe([input.baseline, input.packageSample, ...input.addedPieceSamples.map(s => ({ dps: 0, se: s.se }))]);
	return { packageDeltaDps, bonusDps, se };
}
