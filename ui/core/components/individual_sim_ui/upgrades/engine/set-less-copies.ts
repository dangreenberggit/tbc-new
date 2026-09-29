/**
 * Copies of set pieces, and the same-gear value of one set bonus (tickets 511
 * and 512, ADR-0035).
 *
 * FORK-ONLY, no packages/core ancestor. No request field turns off one set
 * bonus, so a bonus is measured by simming the same gear twice, with some of
 * the set's pieces sent as copies: in one request the copies keep their set,
 * in the other they belong to no set. The copies keep every stat, so the
 * difference is the bonus alone on that gear, with no replacement item's
 * stats mixed in.
 *
 * Why the changed pieces are copies in both requests: a copy has a new item
 * id, and the Go sim reads equipped item ids in several places. It applies
 * item effects by id (`itemEffects[eq.ID]`, sim/core/item_effects.go:75-80),
 * turns on the PvP glove mods only for listed hands ids (`RegisterPvPGloveMod`,
 * sim/core/item_sets.go:274-291), and checks ids in `HasTrinketEquipped` and
 * `HasRingEquipped` (sim/core/character.go:528-535), in weapon checks
 * (character.go:631), in item swaps (sim/core/item_swaps.go:312-317) and in
 * class code (for example sim/paladin/item_librams.go, sim/hunter/hunter.go).
 * A piece that is real in one request and a copy in the other would carry
 * such an effect into the measured value. Sent as a copy in both, it lacks
 * the effect in both, so the effect cancels, and no list of which pieces have
 * such effects is needed. The value is then the bonus on gear without those
 * pieces' id-keyed effects (a second-order difference; hypothesis, untested).
 */

import type { RaidSimRequest } from "./seams/sim-runner.js";
import type { DpsSample } from "./set-value.js";

/**
 * Added to an item id to name that item's set-less copy.
 *
 * The Go sim skips a piece with a blank set name before any set lookup
 * (sim/core/item_sets.go:116-118), so a copy keeps its stats and counts toward
 * no set. The copy cannot reuse the real id: the sim's item map is shared by
 * every request in the process and keeps the first row it sees for an id
 * (sim/core/database.go:54). For the same reason the copy id must be a fixed
 * function of the real id, so every request that names a copy agrees on its
 * row. 1,000,000 is above every item id in the database, and the sum stays
 * inside int32. ADR-0035 has the details.
 */
export const SET_LESS_ID_OFFSET = 1_000_000;

/**
 * Added to an item id to name that item's set-kept copy: the real row with only
 * its id changed. Go matches a piece to its set by set id and name, never by
 * item id (sim/core/item_sets.go:119-131), so the copy still counts toward its
 * set. It needs its own offset because a set-kept and a set-less copy of one
 * item are different rows, and the process-wide item map keeps the first row
 * per id (database.go:54). 2,000,000 + the largest item id stays inside int32.
 */
export const SET_KEPT_ID_OFFSET = 2_000_000;

type MutableItem = { id?: number } & Record<string, unknown>;
type MutablePlayer = {
  equipment?: { items?: MutableItem[] };
  database?: { items?: Array<Record<string, unknown>> };
};

function firstPlayer(request: Record<string, unknown>): MutablePlayer {
  const raid = request.raid as
    | { parties?: Array<{ players?: MutablePlayer[] }> }
    | undefined;
  const player = raid?.parties?.[0]?.players?.[0];
  if (!player) throw new Error("request has no raid.parties[0].players[0]");
  return player;
}

/**
 * A copy of `request` in which the item in each `setLess` slot is its set-less
 * copy and the item in each `setKept` slot is its set-kept copy. When the
 * player has a database, it gains one row per copy, made from the real item's
 * row: a set-less row has `setName` "" and `setId` 0, a set-kept row changes
 * only `id`. Stats and `scalingOptions` carry over in both. A request with no
 * database (the CLI, which is built with the full item database) gets the id
 * swap only.
 */
export function applyCopies(
  request: RaidSimRequest,
  copies: { setLess?: readonly number[]; setKept?: readonly number[] }
): RaidSimRequest {
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
      if (!rows || rows.some((r) => r.id === copyId)) continue;
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`the request database has no row for item ${id}`);
      rows.push({
        ...structuredClone(row),
        id: copyId,
        ...(setLess ? { setName: "", setId: 0 } : {}),
      });
    }
  }
  return out;
}

/** `applyCopies` with set-less copies only. */
export function applySetLessCopies(
  request: RaidSimRequest,
  slots: readonly number[]
): RaidSimRequest {
  return applyCopies(request, { setLess: slots });
}

/**
 * The value of one set bonus on the gear `composedRequest` wears. The first
 * `setPieceSlots.length − lowerCount` set pieces, in slot order, are copies in
 * both sims: set-kept in the "on" sim, set-less in the "off" sim. With
 * `lowerCount` = t − 1 the "off" sim keeps every bonus below t. The value is
 * on − off, and `se` combines both sims' standard errors. Undefined when
 * nothing is left to copy, or when either sim, or building either request,
 * fails.
 */
export async function measureSameGearBonus(
  runSim: (request: RaidSimRequest) => Promise<DpsSample>,
  composedRequest: RaidSimRequest,
  setPieceSlots: readonly number[],
  lowerCount: number
): Promise<DpsSample | undefined> {
  const inSlotOrder = [...setPieceSlots].sort((a, b) => a - b);
  const toCopy = inSlotOrder.slice(0, inSlotOrder.length - lowerCount);
  if (toCopy.length === 0) return undefined;
  try {
    const on = await runSim(applyCopies(composedRequest, { setKept: toCopy }));
    const off = await runSim(applyCopies(composedRequest, { setLess: toCopy }));
    return { dps: on.dps - off.dps, se: Math.sqrt(on.se ** 2 + off.se ** 2) };
  } catch {
    return undefined;
  }
}

/** One count of a worn set's ladder: the value of its c-th piece's bonus. */
export type WornSetRung = {
  count: number;
  dps?: number;
  se?: number;
  unmeasured?: "sim-failed";
};

/**
 * The value of every bonus a worn set has, from 2 up to its worn count, on the
 * gear `composedRequest` wears (ticket 512). With the set's pieces at slots
 * s_1 < … < s_w, rung R(c) for c = 1 … w keeps s_1 real, sends s_2 … s_c as
 * set-kept copies and s_(c+1) … s_w as set-less copies, so Go counts c pieces.
 * No rung sends the real id of s_2 … s_w, so an effect keyed by one of those
 * ids is absent from every rung. The value at count c is R(c) − R(c − 1), with
 * se = √(se_c² + se_(c−1)²), an upper bound because the rungs share a seed. A
 * count at which the set has no bonus reads 0. There is no cap on w: a set
 * with bonuses at 6 or 8 pieces gets those counts too. A failed rung makes
 * both counts that use it `sim-failed`. Empty when w < 2.
 */
export async function measureWornSetLadder(
  runSim: (request: RaidSimRequest) => Promise<DpsSample>,
  composedRequest: RaidSimRequest,
  wornSetSlots: readonly number[]
): Promise<WornSetRung[]> {
  const slots = [...wornSetSlots].sort((a, b) => a - b);
  if (slots.length < 2) return [];
  const rungs: Array<DpsSample | undefined> = [];
  for (let c = 1; c <= slots.length; c++) {
    try {
      rungs[c] = await runSim(
        applyCopies(composedRequest, {
          setKept: slots.slice(1, c),
          setLess: slots.slice(c),
        })
      );
    } catch {
      rungs[c] = undefined;
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
        : { count: c, unmeasured: "sim-failed" }
    );
  }
  return out;
}

/**
 * Whether a same-gear value is above noise: greater than both the set-bonus
 * noise floor and twice its standard error. A value at or below that is not
 * counted as a bonus or a break.
 */
export function clearsSameGearGate(
  dps: number,
  se: number,
  floorDps: number
): boolean {
  return dps > Math.max(floorDps, 2 * se);
}
