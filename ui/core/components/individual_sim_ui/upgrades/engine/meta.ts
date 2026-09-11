/**
 * Meta gem activation.
 *
 * ADAPTED from packages/core/src/meta.ts. packages/core re-derives
 * `gemColorMatchesSocket` and every meta condition (`data/gems/
 * meta-conditions.json`) because the CLI has nothing else to ask. The fork's
 * own `ui/core/proto_utils/gems.ts` already carries both — the same colour
 * table (including the Prismatic-matches-all-three rule this repo's comment
 * calls out as a deliberate divergence from upstream's Go constraint code)
 * and the same per-gem-id `MetaGemCondition` table, upstream-maintained. This
 * module is therefore reused-not-reimplemented: `gemColorMatchesSocket` and
 * `isMetaConditionMet`/`metaDeficit` delegate to the fork's own gems.ts
 * rather than re-encoding the eighteen meta conditions a second time.
 *
 * `socketBonusActive`, `gemColorCounts` and `metaStatus` are PORTED nearly
 * verbatim — they are packages/core's own orchestration over the shared
 * primitives above, not present in the fork's gems.ts.
 */

import { GemColor } from "../../../../proto/common.js";
import {
  gemColorMatchesSocket as upstreamGemColorMatchesSocket,
  getMetaGemCondition,
} from "../../../../proto_utils/gems.js";
import { type GemColour,getGem } from "./gems.js";

export type GemColorCounts = { red: number; yellow: number; blue: number };

export type MetaStatus =
  | { kind: "no-meta-socket" }
  | { kind: "no-meta-gem" }
  | { kind: "active"; metaId: number; counts: GemColorCounts }
  | {
      kind: "inactive";
      metaId: number;
      counts: GemColorCounts;
      description: string;
    };

export function gemColorMatchesSocket(
  gemColor: GemColour,
  socketColor: GemColour
): boolean {
  return upstreamGemColorMatchesSocket(gemColor, socketColor);
}

/**
 * PORTED verbatim from packages/core/src/meta.ts — the socket-bonus-active
 * rule itself (which sockets need to match, meta-only-socket exception) is
 * not present as a standalone function anywhere in the fork, so this stays a
 * direct port over the shared `gemColorMatchesSocket`.
 */
export function socketBonusActive(
  sockets: readonly number[],
  gemIds: readonly number[]
): boolean {
  if (sockets.length === 0) return true;
  if (gemIds.length < sockets.length) return false;

  let sawColoured = false;
  let metaEmpty = false;
  for (let i = 0; i < sockets.length; i++) {
    if (sockets[i] === GemColor.GemColorMeta) {
      if (!gemIds[i]) metaEmpty = true;
      continue;
    }
    sawColoured = true;
    const gem = getGem(gemIds[i] ?? 0);
    if (!gem) return false;
    if (!gemColorMatchesSocket(gem.colour, sockets[i]!)) return false;
  }

  return sawColoured || !metaEmpty;
}

export function gemColorCounts(gemIds: readonly number[]): GemColorCounts {
  const colours: GemColour[] = [];
  for (const id of gemIds) {
    const gem = getGem(id);
    if (gem) colours.push(gem.colour);
  }
  return {
    red: colours.filter((c) => gemColorMatchesSocket(c, GemColor.GemColorRed))
      .length,
    yellow: colours.filter((c) =>
      gemColorMatchesSocket(c, GemColor.GemColorYellow)
    ).length,
    blue: colours.filter((c) => gemColorMatchesSocket(c, GemColor.GemColorBlue))
      .length,
  };
}

export function isMetaConditionMet(
  metaId: number,
  counts: GemColorCounts
): boolean {
  // getMetaGemCondition throws its own "Missing meta gem condition" error,
  // which is already the message packages/core/src/meta.ts's callers expect
  // (`missing meta gem condition for gem: ${id}`) — no need to re-wrap it.
  const cond = getMetaGemCondition(metaId);
  return cond.isMet(counts.red, counts.yellow, counts.blue);
}

/**
 * PORTED from packages/core/src/meta.ts, re-expressed over
 * `getMetaGemCondition` instead of a locally-loaded conditions map — the
 * arithmetic (compare-colour vs min-colour deficit) is packages/core's own
 * and has no fork equivalent, so it is not reused, only its data source is.
 */
export function metaDeficit(metaId: number, counts: GemColorCounts): number {
  const cond = getMetaGemCondition(metaId);
  if (!cond) {
    throw new Error(`missing meta gem condition for gem: ${metaId}`);
  }
  if (cond.isCompareColorCondition()) {
    const greater = categoryCount(cond.compareColorGreater, counts);
    const lesser = categoryCount(cond.compareColorLesser, counts);
    return Math.max(0, lesser - greater + 1);
  }
  return (
    Math.max(0, cond.minRed - counts.red) +
    Math.max(0, cond.minYellow - counts.yellow) +
    Math.max(0, cond.minBlue - counts.blue)
  );
}

function categoryCount(color: number, counts: GemColorCounts): number {
  if (color === GemColor.GemColorRed) return counts.red;
  if (color === GemColor.GemColorYellow) return counts.yellow;
  if (color === GemColor.GemColorBlue) return counts.blue;
  throw new Error(`invalid gem color for category check: ${color}`);
}

/** PORTED verbatim from packages/core/src/meta.ts. */
export function metaStatus(
  headSockets: readonly number[],
  gemIds: readonly number[]
): MetaStatus {
  const hasMetaSocket = headSockets.includes(GemColor.GemColorMeta);
  if (!hasMetaSocket) return { kind: "no-meta-socket" };

  const metaId = gemIds.find(
    (id) => getGem(id)?.colour === GemColor.GemColorMeta
  );
  if (metaId == null) return { kind: "no-meta-gem" };

  const counts = gemColorCounts(gemIds);
  const cond = getMetaGemCondition(metaId);
  if (!cond) {
    throw new Error(`missing meta gem condition for gem: ${metaId}`);
  }
  if (isMetaConditionMet(metaId, counts)) {
    return { kind: "active", metaId, counts };
  }
  return {
    kind: "inactive",
    metaId,
    counts,
    description: cond.description,
  };
}
