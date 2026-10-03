/**
 * Meta repair: the recolours that switch an inactive meta gem back on.
 *
 * PORTED from packages/core/src/meta-repair.ts. Fork-only since ticket 535:
 * an exact search over minimal recolour sets that counts socket bonuses both
 * ways, values hit up to an optional budget, and falls back to greedy with
 * the same value past a work limit. Core keeps plain greedy.
 */

import { GemColor } from "../../../../proto/common.js";
import type { HitCapBudget } from "./cap-profile.js";
import { type GemEntry, getGem } from "./gems.js";
import { getItem } from "./items.js";
import {
  type GemColorCounts,
  gemColorCounts,
  isMetaConditionMet,
  metaDeficit,
  metaStatus,
  socketBonusActive,
} from "./meta.js";
import { epScore, type EpWeights, type Stat } from "./stats.js";

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

/**
 * The most (partial layout, item option) pairs the exact search examines
 * before it stops and repair falls back to greedy. The engine runs on the
 * page's main thread, so the search needs a bound; the largest count measured
 * on the tab fixtures was 1,343,593 (ticket 535). The limit decides which
 * repair a gear gets, so a change to it requires changing the `metaRepair`
 * content-hash key in `rank.ts`.
 */
export const REPAIR_SEARCH_WORK_LIMIT = 5_000_000;

/**
 * How a repair values a layout (ticket 535). With a budget, gems and bonuses
 * are priced without the hit stat, and hit is priced separately, capped at
 * the budget over the layout's total: `w × (min(ΔH, r) − min(0, r))`. The
 * `− min(0, r)` makes the term 0 when the hit does not change, even on gear
 * already over the cap. Without a budget, hit is priced at full weight with
 * the rest, as greedy repair always priced it.
 */
type ValueModel = {
  gem: (gemId: number) => number;
  gemHit: (gemId: number) => number;
  bonus: (itemId: number) => number;
  bonusHit: (itemId: number) => number;
  hitTerm: (dH: number) => number;
};

function weightOf(weights: EpWeights, stat: Stat): number {
  if (Array.isArray(weights)) return (weights as readonly number[])[stat] ?? 0;
  return (weights as Readonly<Record<string, number>>)[String(stat)] ?? 0;
}

function withoutStat(weights: EpWeights, stat: Stat): EpWeights {
  if (Array.isArray(weights)) {
    const out = [...(weights as readonly number[])];
    out[stat] = 0;
    return out;
  }
  return { ...(weights as Readonly<Record<string, number>>), [String(stat)]: 0 };
}

function valueModel(weights: EpWeights, hitCap?: HitCapBudget): ValueModel {
  const priced = hitCap ? withoutStat(weights, hitCap.stat) : weights;
  const gemCache = new Map<number, number>();
  const gem = (gemId: number) => {
    let v = gemCache.get(gemId);
    if (v === undefined) {
      v = gemEp(gemId, priced);
      gemCache.set(gemId, v);
    }
    return v;
  };
  const bonus = (itemId: number) => socketBonusEp(itemId, priced);
  if (!hitCap) {
    return { gem, gemHit: () => 0, bonus, bonusHit: () => 0, hitTerm: () => 0 };
  }
  const { stat, remaining: r } = hitCap;
  const w = weightOf(weights, stat);
  return {
    gem,
    gemHit: (gemId) => (gemId ? (getGem(gemId)?.stats[stat] ?? 0) : 0),
    bonus,
    bonusHit: (itemId) => getItem(itemId)?.socketBonus[stat] ?? 0,
    hitTerm: (dH) => w * (Math.min(dH, r) - Math.min(0, r)),
  };
}

export function repairMeta(opts: {
  items: readonly SocketedItem[];
  epWeights: EpWeights;
  palette: readonly GemEntry[];
  hitCap?: HitCapBudget;
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

  const model = valueModel(opts.epWeights, opts.hitCap);
  const swaps: MetaRepairSwap[] = [];
  const maxSteps = 32;
  // The hit change from the gear before repair, so each move's hit is priced
  // against the budget the earlier moves left.
  let dH = 0;

  for (let step = 0; step < maxSteps; step++) {
    const status = metaStatus(headItem.sockets, allGemIds(items));
    if (status.kind === "active") {
      return { items, metaAdjusted: swaps.length > 0, swaps };
    }
    if (status.kind !== "inactive") {
      throw new MetaInfeasibleError(`unexpected meta status ${status.kind}`);
    }

    const move = bestRepairMove(
      items,
      status.metaId,
      status.counts,
      opts.palette,
      model,
      dH
    );
    if (!move) {
      throw new MetaInfeasibleError(
        `no legal recolour activates meta ${status.metaId} (${status.description})`
      );
    }

    const slot = items[move.itemIndex]!;
    const item = getItem(slot.itemId)!;
    while (slot.gems.length < item.sockets.length) slot.gems.push(0);
    slot.gems[move.socketIndex] = move.to;
    dH = move.dHAfter;
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

/**
 * Switches an inactive meta back on with the best minimal recolour set of at
 * most `d + 1` changes, `d` being the meta's colour deficit (ticket 535).
 * Past the work limit it writes one warning and runs greedy with the same
 * value, which always finishes.
 */
export function repairAndMinimize(opts: {
  items: readonly SocketedItem[];
  epWeights: EpWeights;
  palette: readonly GemEntry[];
  hitCap?: HitCapBudget;
  workLimit?: number;
}): MetaRepairResult {
  const head = opts.items[0];
  const headItem = head ? getItem(head.itemId) : undefined;
  const status = headItem?.sockets.includes(GemColor.GemColorMeta)
    ? metaStatus(headItem.sockets, allGemIds(opts.items))
    : undefined;
  if (status?.kind !== "inactive") {
    return {
      items: opts.items.map((it) => ({ itemId: it.itemId, gems: [...it.gems] })),
      metaAdjusted: false,
      swaps: [],
    };
  }
  const deficit = metaDeficit(status.metaId, status.counts);
  const found = bestMinimalRepair({
    items: opts.items,
    weights: opts.epWeights,
    palette: opts.palette,
    ...(opts.hitCap ? { hitCap: opts.hitCap } : {}),
    maxChanges: deficit + 1,
    ...(opts.workLimit !== undefined ? { workLimit: opts.workLimit } : {}),
  });
  if (found === undefined) {
    throw new MetaInfeasibleError(
      `no recolour set of at most ${deficit + 1} changes activates meta ${status.metaId} (${status.description})`
    );
  }
  if ("overLimit" in found) {
    console.warn(
      "[upgrades] meta repair: exact search passed its work limit, greedy used",
      { metaId: status.metaId, deficit, work: found.work }
    );
    const repaired = repairMeta(opts);
    if (repaired.swaps.length === 0) return repaired;
    return minimizeRegems({
      original: opts.items,
      repaired: repaired.items,
      swaps: repaired.swaps,
    });
  }
  return { items: found.items, metaAdjusted: true, swaps: found.changes };
}

export type MinimalRepair = {
  items: SocketedItem[];
  changes: MetaRepairSwap[];
  /** V of the layout relative to `items`, with no constant added. */
  value: number;
  work: number;
};

/** One partial layout of the search, over the items merged so far. */
type SearchState = {
  value: number;
  dRed: number;
  dYellow: number;
  dBlue: number;
  changes: number;
  dH: number;
  uniques: number[];
  uniquesKey: string;
  /** The change kinds as sorted letters, a multiset in the state key. */
  kinds: string;
  list: ChangeList | null;
};
type ChangeList = { head: Change[]; tail: ChangeList | null };
type Change = { itemIndex: number; socketIndex: number; from: number; to: number };

/** No change of colour: (0 + 1) × 9 + (0 + 1) × 3 + (0 + 1). */
const NO_COLOUR_CHANGE = 13;

/**
 * The best minimal recolour set that switches the meta on (ticket 535).
 *
 * A minimal set: every change places a non-meta palette gem of another
 * colour, the meta is active, undoing any one change leaves it inactive, no
 * unique gem the gear already holds is placed and no placed unique gem
 * repeats, and there are at most `maxChanges` changes. Its value V is the
 * changed gems' EP change, minus each socket bonus switched off, plus each
 * one switched on, plus the hit term of `valueModel`. On a tie the first
 * layout found in SIM_ORDER, socket and palette order wins, so the result is
 * deterministic.
 *
 * The search is a dynamic program over the items. Per gem colour and hit
 * amount only the best non-unique gem can be in an optimum (plus any unique
 * gem that beats it), because the meta and the bonuses read colour alone and
 * the hit term reads total hit alone. A partial layout's state is its multiset
 * of change kinds, its hit change and its placed unique gems, and only the
 * best value per state is kept; that merge is exact because V is a sum over
 * items plus a term of the hit change. `work` counts the (partial layout,
 * item option) pairs the merges examine, skipped ones included; once it
 * passes `workLimit` the search stops and returns `overLimit`. Undefined when
 * no layout qualifies.
 */
export function bestMinimalRepair(opts: {
  items: readonly SocketedItem[];
  weights: EpWeights;
  palette: readonly GemEntry[];
  hitCap?: HitCapBudget;
  maxChanges: number;
  workLimit?: number;
}): MinimalRepair | { overLimit: true; work: number } | undefined {
  const original = opts.items.map((it) => ({
    itemId: it.itemId,
    gems: [...it.gems],
  }));
  const headItem = getItem(original[0]?.itemId ?? 0);
  const status = headItem?.sockets.includes(GemColor.GemColorMeta)
    ? metaStatus(headItem.sockets, allGemIds(original))
    : undefined;
  if (status?.kind !== "inactive") {
    return { items: original, changes: [], value: 0, work: 0 };
  }
  const metaId = status.metaId;
  const limit = opts.workLimit ?? REPAIR_SEARCH_WORK_LIMIT;
  const maxChanges = opts.maxChanges;
  const model = valueModel(opts.weights, opts.hitCap);
  const pool = candidatePool(opts.palette, model);
  const poolUnique = new Set(pool.filter((g) => g.unique).map((g) => g.id));
  const held = new Set(allGemIds(original));
  const base = gemColorCounts(allGemIds(original));
  const colourCache = new Map<number, GemColorCounts>();
  const colourOf = (gemId: number) => {
    let c = colourCache.get(gemId);
    if (!c) {
      c = gemColorCounts(gemId ? [gemId] : []);
      colourCache.set(gemId, c);
    }
    return c;
  };
  const stateKey = (s: SearchState) => `${s.kinds},${s.dH},${s.uniquesKey}`;

  let states = new Map<string, SearchState>();
  const empty: SearchState = {
    value: 0,
    dRed: 0,
    dYellow: 0,
    dBlue: 0,
    changes: 0,
    dH: 0,
    uniques: [],
    uniquesKey: "",
    kinds: "",
    list: null,
  };
  states.set(stateKey(empty), empty);
  let work = 0;

  for (let itemIndex = 0; itemIndex < original.length; itemIndex++) {
    const slot = original[itemIndex]!;
    const item = getItem(slot.itemId);
    if (!item) continue;
    const coloured: number[] = [];
    item.sockets.forEach((colour, s) => {
      if (colour !== GemColor.GemColorMeta) coloured.push(s);
    });
    if (coloured.length === 0) continue;
    const before = [...slot.gems];
    while (before.length < item.sockets.length) before.push(0);
    const matchedBefore = socketBonusActive(item.sockets, slot.gems);
    const trial = [...before];

    // Every way to recolour this item's sockets, best per state.
    const options = new Map<string, SearchState>();
    const visit = (j: number, changes: number) => {
      if (changes > maxChanges) return;
      if (j === coloured.length) {
        let value = 0;
        let dRed = 0;
        let dYellow = 0;
        let dBlue = 0;
        let dH = 0;
        const kinds: string[] = [];
        const placed: number[] = [];
        const head: Change[] = [];
        for (const s of coloured) {
          const from = before[s]!;
          const to = trial[s]!;
          if (from === to) continue;
          value += model.gem(to) - model.gem(from);
          dH += model.gemHit(to) - model.gemHit(from);
          const a = colourOf(from);
          const b = colourOf(to);
          const kind =
            (b.red - a.red + 1) * 9 +
            (b.yellow - a.yellow + 1) * 3 +
            (b.blue - a.blue + 1);
          if (kind === NO_COLOUR_CHANGE) return;
          dRed += b.red - a.red;
          dYellow += b.yellow - a.yellow;
          dBlue += b.blue - a.blue;
          kinds.push(String.fromCharCode(65 + kind));
          if (poolUnique.has(to)) {
            if (placed.includes(to)) return;
            placed.push(to);
          }
          head.push({ itemIndex, socketIndex: s, from, to });
        }
        placed.sort((x, y) => x - y);
        const matchedAfter = socketBonusActive(item.sockets, trial);
        if (matchedBefore && !matchedAfter) value -= model.bonus(slot.itemId);
        if (!matchedBefore && matchedAfter) value += model.bonus(slot.itemId);
        dH +=
          ((matchedAfter ? 1 : 0) - (matchedBefore ? 1 : 0)) *
          model.bonusHit(slot.itemId);
        const option: SearchState = {
          value,
          dRed,
          dYellow,
          dBlue,
          changes,
          dH,
          uniques: placed,
          uniquesKey: placed.join("."),
          kinds: kinds.sort().join(""),
          list: head.length > 0 ? { head, tail: null } : null,
        };
        const key = stateKey(option);
        const prev = options.get(key);
        if (!prev || value > prev.value) options.set(key, option);
        return;
      }
      const s = coloured[j]!;
      trial[s] = before[s]!;
      visit(j + 1, changes);
      for (const g of pool) {
        if (g.id === before[s]) continue;
        if (poolUnique.has(g.id) && held.has(g.id)) continue;
        trial[s] = g.id;
        visit(j + 1, changes + 1);
      }
      trial[s] = before[s]!;
    };
    visit(0, 0);

    const next = new Map<string, SearchState>();
    for (const a of states.values()) {
      for (const b of options.values()) {
        work += 1;
        if (work > limit) return { overLimit: true, work };
        if (a.changes + b.changes > maxChanges) continue;
        if (b.uniques.length > 0 && b.uniques.some((u) => a.uniques.includes(u))) {
          continue;
        }
        const uniques =
          b.uniques.length > 0
            ? [...a.uniques, ...b.uniques].sort((x, y) => x - y)
            : a.uniques;
        const merged: SearchState = {
          value: a.value + b.value,
          dRed: a.dRed + b.dRed,
          dYellow: a.dYellow + b.dYellow,
          dBlue: a.dBlue + b.dBlue,
          changes: a.changes + b.changes,
          dH: a.dH + b.dH,
          uniques,
          uniquesKey: uniques.join("."),
          kinds: (a.kinds + b.kinds).split("").sort().join(""),
          list: b.list ? { head: b.list.head, tail: a.list } : a.list,
        };
        const key = stateKey(merged);
        const prev = next.get(key);
        if (!prev || merged.value > prev.value) next.set(key, merged);
      }
    }
    states = next;
  }

  let best: { value: number; list: ChangeList | null } | undefined;
  for (const s of states.values()) {
    const counts = {
      red: base.red + s.dRed,
      yellow: base.yellow + s.dYellow,
      blue: base.blue + s.dBlue,
    };
    if (!isMetaConditionMet(metaId, counts)) continue;
    // Minimal: undoing one change of any kind present leaves the meta off.
    // The meta reads colour counts only, so one change per kind is enough.
    let minimal = true;
    for (const letter of new Set(s.kinds)) {
      const kind = letter.charCodeAt(0) - 65;
      const red = Math.floor(kind / 9) - 1;
      const yellow = Math.floor((kind % 9) / 3) - 1;
      const blue = (kind % 3) - 1;
      if (
        isMetaConditionMet(metaId, {
          red: counts.red - red,
          yellow: counts.yellow - yellow,
          blue: counts.blue - blue,
        })
      ) {
        minimal = false;
        break;
      }
    }
    if (!minimal) continue;
    const value = s.value + model.hitTerm(s.dH);
    if (!best || value > best.value) best = { value, list: s.list };
  }
  if (!best) return undefined;

  const changes: Change[] = [];
  for (let l = best.list; l; l = l.tail) changes.push(...l.head);
  changes.sort((a, b) => a.itemIndex - b.itemIndex || a.socketIndex - b.socketIndex);
  const items = original.map((it) => ({ itemId: it.itemId, gems: [...it.gems] }));
  const swaps: MetaRepairSwap[] = [];
  for (const c of changes) {
    const slot = items[c.itemIndex]!;
    const item = getItem(slot.itemId)!;
    while (slot.gems.length < item.sockets.length) slot.gems.push(0);
    slot.gems[c.socketIndex] = c.to;
    swaps.push({
      itemId: slot.itemId,
      itemIndex: c.itemIndex,
      socketIndex: c.socketIndex,
      from: c.from,
      to: c.to,
      cost: model.gem(c.from) - model.gem(c.to),
    });
  }
  return { items, changes: swaps, value: best.value, work };
}

/**
 * The search's gems: per (colour, hit amount), the non-unique palette gem with
 * the highest value (the first on a tie), plus each unique gem that beats it.
 */
function candidatePool(
  palette: readonly GemEntry[],
  model: ValueModel
): GemEntry[] {
  const groups = new Map<string, { best?: GemEntry; uniques: GemEntry[] }>();
  for (const g of palette) {
    if (g.colour === GemColor.GemColorMeta || g.colour === GemColor.GemColorUnknown) {
      continue;
    }
    const key = `${g.colour}|${model.gemHit(g.id)}`;
    let group = groups.get(key);
    if (!group) {
      group = { uniques: [] };
      groups.set(key, group);
    }
    if (g.unique) group.uniques.push(g);
    else if (!group.best || model.gem(g.id) > model.gem(group.best.id)) {
      group.best = g;
    }
  }
  const pool: GemEntry[] = [];
  for (const { best, uniques } of groups.values()) {
    if (best) pool.push(best);
    for (const u of uniques) {
      if (!best || model.gem(u.id) > model.gem(best.id)) pool.push(u);
    }
  }
  return pool;
}

/** Hit from every gem plus every active socket bonus (ticket 535). */
export function layoutHitRating(
  items: readonly SocketedItem[],
  stat: Stat
): number {
  let hit = 0;
  for (const it of items) {
    const item = it.itemId ? getItem(it.itemId) : undefined;
    if (!item) continue;
    for (const g of it.gems) {
      if (g) hit += getGem(g)?.stats[stat] ?? 0;
    }
    if (socketsMatch(it.itemId, it.gems)) hit += item.socketBonus[stat] ?? 0;
  }
  return hit;
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
  dHAfter: number;
};

/**
 * The cheapest recolour that lowers the deficit. Its cost is the drop in V it
 * causes: the gem's value change, plus the bonus it switches off, minus the
 * bonus it switches on, plus the hit change priced against the budget the
 * earlier moves left.
 */
function bestRepairMove(
  items: SocketedItem[],
  metaId: number,
  beforeCounts: GemColorCounts,
  palette: readonly GemEntry[],
  model: ValueModel,
  dHBefore: number
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

      for (const candidate of palette) {
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

        const matchedAfter = socketsMatch(slot.itemId, trialGems);
        let cost = model.gem(from) - model.gem(candidate.id);
        if (matchedBefore && !matchedAfter) cost += model.bonus(slot.itemId);
        if (!matchedBefore && matchedAfter) cost -= model.bonus(slot.itemId);
        const dHAfter =
          dHBefore +
          model.gemHit(candidate.id) -
          model.gemHit(from) +
          ((matchedAfter ? 1 : 0) - (matchedBefore ? 1 : 0)) *
            model.bonusHit(slot.itemId);
        cost += model.hitTerm(dHBefore) - model.hitTerm(dHAfter);

        const move: Move = {
          itemIndex,
          socketIndex,
          from,
          to: candidate.id,
          cost,
          dHAfter,
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
