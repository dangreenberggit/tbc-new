/**
 * Copies of set pieces, and the same-gear value of one set bonus.
 *
 * No request field turns off one set bonus, so a bonus is measured by simming the same
 * gear twice with some set pieces sent as copies: set-kept in one request, set-less in
 * the other. Copies keep every stat, so the difference is the bonus alone, except in
 * sockets a meta repair changed, where each request wears the repair chosen for its own
 * hit. The changed pieces are copies in both requests because the Go sim keys item
 * effects, PvP glove mods, trinket, ring and weapon checks, item swaps and class code on
 * item id (for example `itemEffects[eq.ID]`, sim/core/item_effects.go). A copy lacks
 * those effects in both requests, so they cancel.
 */

import type { Cutoff } from './cutoff';
import type { RaidSimRequest } from './seams/sim-runner';
import type { DpsSample } from './set-value';

/**
 * Added to an item id to name its set-less copy. Go skips a piece with a blank set name
 * (`getSetBonuses`, sim/core/item_sets.go). The copy cannot reuse the real id, and must be
 * a fixed function of it, because the item map is shared by every request in the process
 * and keeps the first row per id (`addToDatabase`, sim/core/database.go). 1,000,000 is
 * above every item id, and the sum stays inside int32.
 */
export const SET_LESS_ID_OFFSET = 1_000_000;

/**
 * Added to an item id to name its set-kept copy: the real row with only its id changed. Go
 * matches a piece to its set by set id and name, not item id, so the copy still counts.
 * Its own offset keeps the set-kept and set-less rows of one item apart in the
 * first-row-per-id map; the sum stays inside int32.
 */
export const SET_KEPT_ID_OFFSET = 2_000_000;

type MutableItem = { id?: number } & Record<string, unknown>;
type MutablePlayer = {
	equipment?: { items?: MutableItem[] };
	database?: { items?: Array<Record<string, unknown>> };
};

function firstPlayer(request: Record<string, unknown>): MutablePlayer {
	const raid = request.raid as { parties?: Array<{ players?: MutablePlayer[] }> } | undefined;
	const player = raid?.parties?.[0]?.players?.[0];
	if (!player) throw new Error('request has no raid.parties[0].players[0]');
	return player;
}

/**
 * A copy of `request` with each `setLess` slot's item swapped for its set-less copy and
 * each `setKept` slot's for its set-kept copy. A player database gains one row per copy,
 * from the real row: set-less has `setName` "" and `setId` 0, set-kept changes only `id`.
 * A request with no database (the CLI, built with the full item database) gets the id
 * swap only.
 */
export function applyCopies(request: RaidSimRequest, copies: { setLess?: readonly number[]; setKept?: readonly number[] }): RaidSimRequest {
	const out = structuredClone(request) as Record<string, unknown>;
	const player = firstPlayer(out);
	const items = player.equipment?.items ?? [];
	const rows = player.database ? (player.database.items ??= []) : undefined;
	const kinds = [
		{ slots: copies.setLess ?? [], offset: SET_LESS_ID_OFFSET, setLess: true },
		{ slots: copies.setKept ?? [], offset: SET_KEPT_ID_OFFSET, setLess: false },
	];
	for (const { slots, offset, setLess } of kinds) {
		for (const slot of slots) {
			const item = items[slot];
			const id = item?.id;
			if (!item || !id || id >= SET_LESS_ID_OFFSET) {
				throw new Error(`slot ${slot} holds no item that can be copied`);
			}
			const copyId = offset + id;
			item.id = copyId;
			if (!rows || rows.some(r => r.id === copyId)) continue;
			const row = rows.find(r => r.id === id);
			if (!row) throw new Error(`the request database has no row for item ${id}`);
			rows.push({
				...structuredClone(row),
				id: copyId,
				...(setLess ? { setName: '', setId: 0 } : {}),
			});
		}
	}
	return out;
}

/** `applyCopies` with set-less copies only. */
export function applySetLessCopies(request: RaidSimRequest, slots: readonly number[]): RaidSimRequest {
	return applyCopies(request, { setLess: slots });
}

/** A sim that failed, with the sim's own error text for the player. */
export type SimFailure = { simError: string };

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A request that could not be built, with the error that stopped it; no sim ran. */
export type BuildFailure = { buildError: string };

export const isBuildFailure = <T extends object>(value: T | BuildFailure | undefined): value is BuildFailure => value !== undefined && 'buildError' in value;

/**
 * One set bonus's value on `composedRequest`'s gear, on − off: the first
 * `setPieceSlots.length − lowerCount` set pieces in slot order are set-kept copies in the
 * "on" sim and set-less in the "off" sim, so `lowerCount` = t − 1 keeps every bonus below
 * t in both. Undefined when nothing is left to copy. With `requestsFor`, both requests come
 * from one call so each can carry the gems repair chose for its own hit; a rejection from
 * it goes to the caller.
 */
export async function measureSameGearBonus(
	runSim: (request: RaidSimRequest) => Promise<DpsSample>,
	composedRequest: RaidSimRequest,
	setPieceSlots: readonly number[],
	lowerCount: number,
	requestsFor?: (copiesList: Array<{ setKept: number[]; setLess: number[] }>) => Promise<Array<RaidSimRequest | BuildFailure>>,
): Promise<DpsSample | SimFailure | BuildFailure | undefined> {
	const inSlotOrder = [...setPieceSlots].sort((a, b) => a - b);
	const toCopy = inSlotOrder.slice(0, inSlotOrder.length - lowerCount);
	if (toCopy.length === 0) return undefined;
	const requests = await requestsFor?.([
		{ setKept: toCopy, setLess: [] },
		{ setKept: [], setLess: toCopy },
	]);
	let onRequest: RaidSimRequest | BuildFailure | undefined;
	let offRequest: RaidSimRequest | BuildFailure | undefined;
	if (requests) {
		[onRequest, offRequest] = requests;
	} else {
		try {
			onRequest = applyCopies(composedRequest, { setKept: toCopy });
			offRequest = applyCopies(composedRequest, { setLess: toCopy });
		} catch (err) {
			return { buildError: errorText(err) };
		}
	}
	if (!onRequest || !offRequest) return undefined;
	if (isBuildFailure(onRequest)) return onRequest;
	if (isBuildFailure(offRequest)) return offRequest;
	try {
		const on = await runSim(onRequest);
		const off = await runSim(offRequest);
		return { dps: on.dps - off.dps, se: Math.sqrt(on.se ** 2 + off.se ** 2) };
	} catch (err) {
		return { simError: errorText(err) };
	}
}

export const isSimFailure = <T extends object>(value: T | SimFailure | undefined): value is SimFailure => value !== undefined && 'simError' in value;

/** One count of a worn set's ladder: the value of its c-th piece's bonus. */
export type WornSetRung = {
	count: number;
	dps?: number;
	se?: number;
	unmeasured?: 'sim-failed';
};

/**
 * Every bonus value of a worn set, from count 2 to its worn count w; empty when w < 2. With
 * the pieces at slots s_1 < … < s_w, rung R(c) keeps s_1 real, sends s_2 … s_c as set-kept
 * copies and the rest as set-less, so Go counts c pieces and no rung carries an id-keyed
 * effect of s_2 … s_w. Count c's value is R(c) − R(c − 1); its se is an upper bound, as
 * the rungs share a seed. A failed rung makes both counts that use it `sim-failed`, and
 * `onFailed` gets `notBuilt` when its request could not be built.
 */
export async function measureWornSetLadder(
	runSim: (request: RaidSimRequest) => Promise<DpsSample>,
	composedRequest: RaidSimRequest,
	wornSetSlots: readonly number[],
	onFailed?: (error: string, notBuilt?: true) => void,
): Promise<WornSetRung[]> {
	const slots = [...wornSetSlots].sort((a, b) => a - b);
	if (slots.length < 2) return [];
	const rungs: Array<DpsSample | undefined> = [];
	for (let c = 1; c <= slots.length; c++) {
		let request: RaidSimRequest;
		try {
			request = applyCopies(composedRequest, {
				setKept: slots.slice(1, c),
				setLess: slots.slice(c),
			});
		} catch (err) {
			rungs[c] = undefined;
			onFailed?.(errorText(err), true);
			continue;
		}
		try {
			rungs[c] = await runSim(request);
		} catch (err) {
			rungs[c] = undefined;
			onFailed?.(errorText(err));
		}
	}
	const out: WornSetRung[] = [];
	for (let c = 2; c <= slots.length; c++) {
		const upper = rungs[c];
		const lower = rungs[c - 1];
		out.push(
			upper && lower
				? {
						count: c,
						dps: upper.dps - lower.dps,
						se: Math.sqrt(upper.se ** 2 + lower.se ** 2),
					}
				: { count: c, unmeasured: 'sim-failed' },
		);
	}
	return out;
}

/**
 * Whether a same-gear value is above noise: greater than both `cutoff.absDps` and twice
 * its SE. Every value it reads is one sim minus another, so it gets the item bar, not the
 * four-sim `setBonusNoiseFloorDps`; taking the `Cutoff`, not a number, keeps that floor
 * from being passed in.
 */
export function clearsSameGearGate(dps: number, se: number, cutoff: Cutoff): boolean {
	return dps > Math.max(cutoff.absDps, 2 * se);
}
