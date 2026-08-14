/**
 * Fill empty sockets on a candidate item with highest-EP gems from the phase
 * palette.
 *
 * PORTED from packages/core/src/candidate-gems.ts, unchanged except for
 * import paths retargeted at this directory's Database-backed items.ts/
 * gems.ts/meta.ts adapters.
 */

import { fillEligibleGems, getGem, type GemEntry } from "./gems.js";
import { getItem, socketsFor } from "./items.js";
import {
  gemColorCounts,
  gemColorMatchesSocket,
  metaDeficit,
  socketBonusActive,
} from "./meta.js";
import { GemColor } from "../../../../proto/common.js";
import { epScore, Stat, type EpWeights } from "./stats.js";
import type { DetectedSpecId } from "./types.js";

type EpWeightRecord = Readonly<Record<string, number>>;

export type GemContext = {
  readonly palette: readonly GemEntry[];
  readonly fillPalette: readonly GemEntry[];
  readonly weights: EpWeights;
  readonly weightRecord: EpWeightRecord;
  readonly spec?: DetectedSpecId;
};

export function gemContext(
  palette: readonly GemEntry[],
  weights: EpWeights,
  spec?: DetectedSpecId
): GemContext {
  return {
    palette,
    fillPalette: fillEligibleGems(palette),
    weights,
    weightRecord: toWeightRecord(weights),
    ...(spec !== undefined ? { spec } : {}),
  };
}

function toWeightRecord(weights: EpWeights): EpWeightRecord {
  if (!Array.isArray(weights)) return weights as EpWeightRecord;
  const out: Record<string, number> = {};
  for (let i = 0; i < weights.length; i++) out[String(i)] = weights[i] ?? 0;
  return out;
}

const META_NEAR_EP = 1.0;

/**
 * Ret's meta is Relentless Earthstorm Diamond — see packages/core/src/
 * candidate-gems.ts for the full derivation (upstream gear presets at the
 * pin, crit-damage-multiplier argument for why stat EP cannot rank metas).
 * Unchanged by the port: this is a fact about the game, not about which repo
 * is asking.
 */
const PREFERRED_META_IDS: readonly number[] = [32409];

/**
 * PORTED verbatim from packages/core/src/candidate-gems.ts. See that file's
 * doc comment for the evidence procedure and the "grow this table with
 * DetectedSpecId" warning — both apply unchanged here.
 */
export const SPEC_PREFERRED_METAS: Partial<
  Record<DetectedSpecId, readonly number[]>
> = {
  ret: PREFERRED_META_IDS,
};

export function missingMetaPreferenceNote(
  spec: DetectedSpecId | undefined
): string | undefined {
  if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return undefined;
  return `no meta preference recorded for ${spec} — meta sockets on candidate items were left empty, so those items are priced without any meta gem's stats or effect`;
}

export function metaSocketUnpriced(
  itemId: number,
  gems: readonly number[],
  spec: DetectedSpecId | undefined
): boolean {
  if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return false;
  const metaIdx = socketsFor(itemId).indexOf(GemColor.GemColorMeta);
  if (metaIdx < 0) return false;
  return !gems[metaIdx];
}

export type FillEmptyOpts = {
  usedUnique?: ReadonlySet<number>;
  meta?: { metaId: number; otherGemIds: readonly number[] };
  spec?: DetectedSpecId;
};

export function fillEmptyCandidateGems(
  itemId: number,
  gems: readonly number[],
  palette: readonly GemEntry[],
  epWeights: EpWeightRecord,
  opts: FillEmptyOpts = {}
): number[] {
  const sockets = socketsFor(itemId);
  if (sockets.length === 0) return [];

  const weights = gemFillWeights(epWeights);
  const base = sockets.map((_, i) => gems[i] ?? 0);
  const matched = fillEmpties(sockets, base, palette, weights, true, opts);
  const free = fillEmpties(sockets, base, palette, weights, false, opts);
  return layoutScore(itemId, sockets, free, weights) >
    layoutScore(itemId, sockets, matched, weights)
    ? free
    : matched;
}

export function gemFillWeights(
  epWeights: EpWeightRecord
): Record<string, number> {
  const out: Record<string, number> = { ...epWeights };
  out[String(Stat.StatMeleeHitRating)] = 0;
  out[String(Stat.StatExpertiseRating)] = 0;
  return out;
}

function fillEmpties(
  sockets: readonly number[],
  base: readonly number[],
  palette: readonly GemEntry[],
  epWeights: EpWeightRecord,
  matchColors: boolean,
  opts: FillEmptyOpts
): number[] {
  const out = [...base];
  const usedUnique = new Set(opts.usedUnique ?? []);
  for (const id of out) {
    const g = getGem(id);
    if (g?.unique) usedUnique.add(id);
  }

  for (let i = 0; i < sockets.length; i++) {
    if ((out[i] ?? 0) > 0) continue;
    const placed = out.filter((id) => id > 0);
    const pick = bestGemForSocket(
      sockets[i]!,
      palette,
      epWeights,
      usedUnique,
      matchColors,
      opts.meta
        ? {
            metaId: opts.meta.metaId,
            setGemIds: [...opts.meta.otherGemIds, ...placed],
          }
        : undefined,
      opts.spec
    );
    if (pick) {
      out[i] = pick.id;
      if (pick.unique) usedUnique.add(pick.id);
    } else {
      out[i] = 0;
    }
  }

  return out;
}

function bestGemForSocket(
  socket: number,
  palette: readonly GemEntry[],
  epWeights: EpWeightRecord,
  usedUnique: ReadonlySet<number>,
  matchColors: boolean,
  metaCtx: { metaId: number; setGemIds: readonly number[] } | undefined,
  spec: DetectedSpecId | undefined
): GemEntry | undefined {
  const eligible: { gem: GemEntry; ep: number }[] = [];

  for (const gem of palette) {
    if (gem.unique && usedUnique.has(gem.id)) continue;

    if (socket === GemColor.GemColorMeta) {
      if (gem.colour !== GemColor.GemColorMeta) continue;
    } else if (gem.colour === GemColor.GemColorMeta) {
      continue;
    } else if (matchColors && !gemColorMatchesSocket(gem.colour, socket)) {
      continue;
    }

    eligible.push({ gem, ep: epScore(gem.stats, epWeights) });
  }

  if (eligible.length === 0) return undefined;

  if (socket === GemColor.GemColorMeta) {
    const preferredIds =
      spec === undefined ? PREFERRED_META_IDS : SPEC_PREFERRED_METAS[spec];
    if (!preferredIds) return undefined;
    for (const preferred of preferredIds) {
      const hit = eligible.find((e) => e.gem.id === preferred);
      if (hit) return hit.gem;
    }
  }

  let bestEp = -Infinity;
  for (const e of eligible) {
    if (e.ep > bestEp) bestEp = e.ep;
  }

  const near = eligible.filter((e) => bestEp - e.ep <= META_NEAR_EP);
  const pool = near.length > 0 ? near : eligible;

  if (!metaCtx) {
    return pool.reduce((a, b) => (b.ep > a.ep ? b : a)).gem;
  }

  let best: { gem: GemEntry; ep: number; deficit: number } | undefined;
  for (const e of pool) {
    const afterDeficit = metaDeficit(
      metaCtx.metaId,
      gemColorCounts([...metaCtx.setGemIds, e.gem.id])
    );
    if (
      !best ||
      afterDeficit < best.deficit ||
      (afterDeficit === best.deficit && e.ep > best.ep)
    ) {
      best = { gem: e.gem, ep: e.ep, deficit: afterDeficit };
    }
  }

  return best?.gem;
}

function layoutScore(
  itemId: number,
  sockets: readonly number[],
  gemIds: readonly number[],
  epWeights: EpWeightRecord
): number {
  let score = 0;
  for (const id of gemIds) {
    const gem = getGem(id);
    if (gem) score += epScore(gem.stats, epWeights);
  }

  if (socketBonusActive(sockets, gemIds)) {
    const bonus = getItem(itemId)?.socketBonus;
    if (bonus) score += epScore(bonus, epWeights);
  }

  return score;
}

export function gemEp(gemId: number, epWeights: EpWeightRecord): number {
  const gem = getGem(gemId);
  return gem ? epScore(gem.stats, epWeights) : 0;
}
