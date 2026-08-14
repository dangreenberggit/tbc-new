/**
 * Minimum-EP-loss meta repair.
 *
 * PORTED from packages/core/src/meta-repair.ts, unchanged except for import
 * paths retargeted at this directory's adapters.
 */

import { getGem, type GemEntry } from "./gems.js";
import { getItem } from "./items.js";
import {
  gemColorCounts,
  metaDeficit,
  metaStatus,
  socketBonusActive,
  type GemColorCounts,
} from "./meta.js";
import { GemColor } from "../../../../proto/common.js";
import { epScore, type EpWeights } from "./stats.js";

export type SocketedItem = {
  itemId: number;
  gems: number[];
};

export type MetaRepairSwap = {
  itemId: number;
  itemIndex: number;
  socketIndex: number;
  from: number;
  to: number;
  cost: number;
};

export type MetaRepairResult = {
  items: SocketedItem[];
  metaAdjusted: boolean;
  swaps: MetaRepairSwap[];
};

export abstract class MetaRepairError extends Error {}

export class MetaInfeasibleError extends MetaRepairError {
  constructor(message: string) {
    super(message);
    this.name = "MetaInfeasibleError";
  }
}

export class MetaStepBudgetExceededError extends MetaRepairError {
  constructor(message: string) {
    super(message);
    this.name = "MetaStepBudgetExceededError";
  }
}

export function repairMeta(opts: {
  items: readonly SocketedItem[];
  epWeights: EpWeights;
  palette: readonly GemEntry[];
}): MetaRepairResult {
  const items = opts.items.map((it) => ({
    itemId: it.itemId,
    gems: [...it.gems],
  }));

  const head = items[0];
  if (!head) {
    return { items, metaAdjusted: false, swaps: [] };
  }
  const headItem = getItem(head.itemId);
  if (!headItem?.sockets.includes(GemColor.GemColorMeta)) {
    return { items, metaAdjusted: false, swaps: [] };
  }

  const initial = metaStatus(headItem.sockets, allGemIds(items));
  if (initial.kind !== "inactive") {
    return { items, metaAdjusted: false, swaps: [] };
  }

  const swaps: MetaRepairSwap[] = [];
  const maxSteps = 32;

  for (let step = 0; step < maxSteps; step++) {
    const status = metaStatus(headItem.sockets, allGemIds(items));
    if (status.kind === "active") {
      return { items, metaAdjusted: swaps.length > 0, swaps };
    }
    if (status.kind !== "inactive") {
      throw new MetaInfeasibleError(`unexpected meta status ${status.kind}`);
    }

    const move = bestRepairMove(items, status.metaId, status.counts, opts);
    if (!move) {
      throw new MetaInfeasibleError(
        `no legal recolour activates meta ${status.metaId} (${status.description})`
      );
    }

    const slot = items[move.itemIndex]!;
    slot.gems[move.socketIndex] = move.to;
    swaps.push({
      itemId: slot.itemId,
      itemIndex: move.itemIndex,
      socketIndex: move.socketIndex,
      from: move.from,
      to: move.to,
      cost: move.cost,
    });
  }

  throw new MetaStepBudgetExceededError("meta repair exceeded step budget");
}

function allGemIds(items: readonly SocketedItem[]): number[] {
  const ids: number[] = [];
  for (const it of items) {
    for (const g of it.gems) {
      if (g) ids.push(g);
    }
  }
  return ids;
}

export function minimizeRegems(opts: {
  original: readonly SocketedItem[];
  repaired: readonly SocketedItem[];
  swaps: readonly MetaRepairSwap[];
}): MetaRepairResult {
  const { original, repaired, swaps } = opts;
  const items = repaired.map((it) => ({
    itemId: it.itemId,
    gems: [...it.gems],
  }));
  const metaItem = items
    .map((it) => getItem(it.itemId))
    .find((entry) => entry?.sockets.includes(GemColor.GemColorMeta));
  if (!metaItem) {
    return { items, metaAdjusted: swaps.length > 0, swaps: [...swaps] };
  }

  const survivingSwaps: MetaRepairSwap[] = [];

  for (const swap of swaps) {
    const slot = items[swap.itemIndex];
    const originalGem = original[swap.itemIndex]?.gems[swap.socketIndex];
    const socketColor = slot && getItem(slot.itemId)?.sockets[swap.socketIndex];
    if (
      !slot ||
      slot.itemId !== swap.itemId ||
      !originalGem ||
      socketColor === GemColor.GemColorMeta
    ) {
      survivingSwaps.push(swap);
      continue;
    }

    const before = slot.gems[swap.socketIndex];
    slot.gems[swap.socketIndex] = originalGem;
    const status = metaStatus(metaItem.sockets, allGemIds(items));
    if (status.kind === "active") {
      continue;
    }
    slot.gems[swap.socketIndex] = before ?? 0;
    survivingSwaps.push(swap);
  }

  return {
    items,
    metaAdjusted: survivingSwaps.length > 0,
    swaps: survivingSwaps,
  };
}

export function repairAndMinimize(opts: {
  items: readonly SocketedItem[];
  epWeights: EpWeights;
  palette: readonly GemEntry[];
}): MetaRepairResult {
  const repaired = repairMeta(opts);
  if (repaired.swaps.length === 0) return repaired;
  return minimizeRegems({
    original: opts.items,
    repaired: repaired.items,
    swaps: repaired.swaps,
  });
}

export function socketsMatch(itemId: number, gems: readonly number[]): boolean {
  const item = getItem(itemId);
  if (!item) return true;
  return socketBonusActive(item.sockets, gems);
}

function gemEp(gemId: number, weights: EpWeights): number {
  if (!gemId) return 0;
  const gem = getGem(gemId);
  if (!gem) return 0;
  return epScore(gem.stats, weights);
}

function socketBonusEp(itemId: number, weights: EpWeights): number {
  const item = getItem(itemId);
  if (!item) return 0;
  return epScore(item.socketBonus, weights);
}

type Move = {
  itemIndex: number;
  socketIndex: number;
  from: number;
  to: number;
  cost: number;
};

function bestRepairMove(
  items: SocketedItem[],
  metaId: number,
  beforeCounts: GemColorCounts,
  opts: { epWeights: EpWeights; palette: readonly GemEntry[] }
): Move | null {
  const beforeDeficit = metaDeficit(metaId, beforeCounts);
  let best: Move | null = null;

  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const slot = items[itemIndex]!;
    const item = getItem(slot.itemId);
    if (!item) continue;

    for (
      let socketIndex = 0;
      socketIndex < item.sockets.length;
      socketIndex++
    ) {
      const socketColor = item.sockets[socketIndex]!;
      if (socketColor === GemColor.GemColorMeta) continue;

      const from = slot.gems[socketIndex] ?? 0;
      const matchedBefore = socketsMatch(slot.itemId, slot.gems);

      for (const candidate of opts.palette) {
        if (candidate.colour === GemColor.GemColorMeta) continue;
        if (candidate.unique && alreadyHasUnique(items, candidate.id, from)) {
          continue;
        }
        if (candidate.id === from) continue;

        const trialGems = [...slot.gems];
        while (trialGems.length < item.sockets.length) trialGems.push(0);
        trialGems[socketIndex] = candidate.id;

        const trialItems = items.map((it, i) =>
          i === itemIndex ? { itemId: it.itemId, gems: trialGems } : it
        );
        const afterCounts = gemColorCounts(allGemIds(trialItems));
        const afterDeficit = metaDeficit(metaId, afterCounts);
        if (afterDeficit >= beforeDeficit) continue;

        let cost =
          gemEp(from, opts.epWeights) - gemEp(candidate.id, opts.epWeights);
        if (matchedBefore && !socketsMatch(slot.itemId, trialGems)) {
          cost += socketBonusEp(slot.itemId, opts.epWeights);
        }

        const move: Move = {
          itemIndex,
          socketIndex,
          from,
          to: candidate.id,
          cost,
        };
        if (!best || move.cost < best.cost) best = move;
      }
    }
  }

  return best;
}

function alreadyHasUnique(
  items: readonly SocketedItem[],
  gemId: number,
  replacing: number
): boolean {
  for (const it of items) {
    for (const g of it.gems) {
      if (g === gemId && g !== replacing) return true;
    }
  }
  return false;
}
