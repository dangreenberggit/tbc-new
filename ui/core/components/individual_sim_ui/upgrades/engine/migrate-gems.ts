/**
 * Move gems from a worn piece onto a candidate item the way wowsims UI
 * `EquippedItem.withItem` does.
 *
 * PORTED from packages/core/src/migrate-gems.ts, retargeted at this
 * directory's `items.ts`/`gems.ts`/`meta.ts` adapters instead of
 * packages/core's JSON-backed ones. `gemEligibleForSocket` duplicates the
 * fork's own `ui/core/proto_utils/gems.ts` export of the same name — kept
 * local rather than re-exported from there because packages/core's tests
 * import it from this module's path and the port preserves that surface;
 * the two implementations are identical one-liners over the same GemColor
 * enum, so there is nothing to drift.
 */

import { GemColor } from "../../../../proto/common.js";
import { getGem } from "./gems.js";
import { socketsFor } from "./items.js";
import { gemColorMatchesSocket } from "./meta.js";

export function migrateGemsToItem(
  wornGems: readonly number[],
  wornItemId: number,
  newItemId: number
): number[] {
  const newSockets = socketsFor(newItemId);
  if (newSockets.length === 0) return [];

  const wornSocketCount = socketsFor(wornItemId).length;
  const source = wornGems
    .slice(0, wornSocketCount > 0 ? wornSocketCount : wornGems.length)
    .filter((id) => id > 0);

  const out: number[] = new Array(newSockets.length).fill(0);

  for (const gemId of source) {
    const gem = getGem(gemId);
    if (!gem) continue;

    const matchIdx = newSockets.findIndex(
      (socket, i) =>
        out[i] === 0 &&
        gemEligibleForSocket(gem.colour, socket) &&
        gemColorMatchesSocket(gem.colour, socket)
    );
    if (matchIdx >= 0) {
      out[matchIdx] = gemId;
      continue;
    }

    const eligibleIdx = newSockets.findIndex(
      (socket, i) => out[i] === 0 && gemEligibleForSocket(gem.colour, socket)
    );
    if (eligibleIdx >= 0) out[eligibleIdx] = gemId;
  }

  return out;
}

export function gemEligibleForSocket(
  gemColour: number,
  socketColour: number
): boolean {
  if (socketColour === GemColor.GemColorMeta) {
    return gemColour === GemColor.GemColorMeta;
  }
  return gemColour !== GemColor.GemColorMeta;
}
