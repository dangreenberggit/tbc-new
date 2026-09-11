/**
 * Gem palette — Database-backed, NOT ported from packages/core/src/gems.ts.
 *
 * Same reasoning as items.ts: packages/core reads a generated
 * `data/gems/palette.json` snapshot because the CLI has no live gem list to
 * ask. The fork's `Database.getSync().getGems()` already returns every gem
 * TBC ships, sourced from the same wowsims db.json this repo's snapshot was
 * generated from — so this is a projection over the live Database, not a
 * second copy of the data.
 *
 * `findMetaGemId` is ported unchanged from packages/core/src/gems.ts: it is
 * pure over a `GemEntry[]`/`GemColour` and does not touch the data source.
 */

import { GemColor } from "../../../../proto/common.js";
import { Database } from "../../../../proto_utils/database.js";

export type GemColour = number;

export type GemEntry = {
  id: number;
  colour: GemColour;
  stats: number[];
  phase: number;
  /** wowsims ItemQuality: 2 uncommon, 3 rare, 4 epic — same numbering as core. */
  quality: number;
  unique: boolean;
};

function toGemEntry(gem: {
  id: number;
  color: GemColor;
  stats: number[];
  phase: number;
  quality: number;
  unique: boolean;
}): GemEntry {
  return {
    id: gem.id,
    colour: gem.color,
    stats: gem.stats,
    phase: gem.phase,
    quality: gem.quality,
    unique: gem.unique,
  };
}

export function gemPalette(): readonly GemEntry[] {
  return Database.getSync().getGems().map(toGemEntry);
}

export function getGem(gemId: number): GemEntry | undefined {
  const gem = Database.getSync().lookupGem(gemId);
  return gem ? toGemEntry(gem) : undefined;
}

export function gemsForPhase(maxPhase: number): GemEntry[] {
  return gemPalette().filter((g) => g.phase <= maxPhase);
}

/**
 * PORTED unchanged from packages/core/src/gems.ts — pure filter over
 * `GemEntry[]`, no data-source dependency.
 */
export function gemsForQuality(
  palette: readonly GemEntry[],
  maxQuality: number
): GemEntry[] {
  return palette.filter((g) => {
    if (typeof g.quality !== "number") {
      throw new Error(
        `gem ${g.id} has non-numeric quality (${String(g.quality)}); cannot apply the rarity cap`
      );
    }
    return g.quality <= maxQuality;
  });
}

/** PORTED unchanged from packages/core/src/gems.ts. */
export const FILL_MAX_QUALITY = 3;

export function fillEligibleGems(
  palette: readonly GemEntry[]
): readonly GemEntry[] {
  return gemsForQuality(palette, FILL_MAX_QUALITY);
}

/** PORTED unchanged from packages/core/src/gems.ts. */
export function findMetaGemId(gemIds: readonly number[]): number | undefined {
  for (const id of gemIds) {
    if (getGem(id)?.colour === GemColor.GemColorMeta) return id;
  }
  return undefined;
}
