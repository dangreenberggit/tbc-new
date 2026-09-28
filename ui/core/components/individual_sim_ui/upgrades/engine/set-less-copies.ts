/**
 * Set-less copies of set pieces, and the same-gear value of one set bonus
 * (ticket 511, ADR-0035).
 *
 * FORK-ONLY, no packages/core ancestor. No request field turns off one set
 * bonus, so a bonus is measured by simming the same gear twice: once as it is,
 * and once with enough of the set's pieces swapped for copies that belong to
 * no set. The copies keep every stat, so the difference is the bonus alone on
 * that gear, with no replacement item's stats mixed in.
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
 * A copy of `request` in which the item in each listed equipment slot is its
 * set-less copy. When the player has a database, it gains one row per copy:
 * the real item's row with `setName` "" and `setId` 0, so its stats and
 * `scalingOptions` carry over. A request with no database (the CLI, which is
 * built with the full item database) gets the id swap only.
 */
export function applySetLessCopies(
  request: RaidSimRequest,
  slots: readonly number[]
): RaidSimRequest {
  const out = structuredClone(request) as Record<string, unknown>;
  const player = firstPlayer(out);
  const items = player.equipment?.items ?? [];
  const rows = player.database ? (player.database.items ??= []) : undefined;
  for (const slot of slots) {
    const item = items[slot];
    const id = item?.id;
    if (!item || !id || id >= SET_LESS_ID_OFFSET) {
      throw new Error(`slot ${slot} holds no item that can be made set-less`);
    }
    const copyId = SET_LESS_ID_OFFSET + id;
    item.id = copyId;
    if (!rows || rows.some((r) => r.id === copyId)) continue;
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`the request database has no row for item ${id}`);
    rows.push({ ...structuredClone(row), id: copyId, setName: "", setId: 0 });
  }
  return out;
}

/**
 * The value of one set bonus on the gear `composedRequest` wears: the request's
 * DPS minus the DPS of the same request with the first
 * `setPieceSlots.length − lowerCount` set pieces, in slot order, made
 * set-less. With `lowerCount` = t − 1 that turns off the t-piece bonus and
 * keeps every lower one. `se` combines both sims' standard errors. Undefined
 * when either sim, or building the set-less request, fails.
 *
 * `runSim` should be the caller's cached run: the caller has usually simmed
 * `composedRequest` already, and then only the set-less request is a new sim.
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
    const on = await runSim(composedRequest);
    const off = await runSim(applySetLessCopies(composedRequest, toCopy));
    return { dps: on.dps - off.dps, se: Math.sqrt(on.se ** 2 + off.se ** 2) };
  } catch {
    return undefined;
  }
}
