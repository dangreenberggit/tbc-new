/**
 * Meta repair: the gem recolors that switch an inactive meta gem back on. An exact search
 * over the minimal sets of recolors, counting socket bonuses gained and lost and, with a
 * hit budget, valuing hit only up to the cap. Past a work limit it falls back to a greedy
 * search that values layouts the same way.
 */

import { GemColor } from '@generated/proto/common';

import type { HitCapBudget } from './cap-profile';
import { type GemEntry, getGem } from './gems';
import { getItem } from './items';
import { type GemColorCounts, gemColorCounts, isMetaConditionMet, metaDeficit, type MetaStatus, metaStatus, socketBonusActive } from './meta';
import { epScore, type EpWeights, type Stat } from './stats';

export type SocketedItem = {
	itemId: number;
	gems: number[];
};

export type GemRecolor = {
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
	recolors: GemRecolor[];
};

export abstract class MetaRepairError extends Error {}

export class MetaInfeasibleError extends MetaRepairError {
	constructor(message: string) {
		super(message);
		this.name = 'MetaInfeasibleError';
	}
}

export class MetaRecolorLimitExceededError extends MetaRepairError {
	constructor(message: string) {
		super(message);
		this.name = 'MetaRecolorLimitExceededError';
	}
}

/**
 * The most work (`work`) the exact search may do before repair falls back to greedy; the
 * engine runs on the page's main thread, so the search needs a bound. The limit decides
 * which repair a gear gets, so it is part of the `metaRepair` cache key in `rank.ts`.
 */
export const REPAIR_SEARCH_WORK_LIMIT = 5_000_000;

/**
 * How a repair values a layout. Without a hit budget, hit is priced at full weight with
 * the other stats. With one, gems and bonuses are priced without hit, and a hit change
 * `dH` is priced at weight `w` only up to the hit still needed (`r`):
 * `w × (min(dH, r) − min(0, r))`. The `− min(0, r)` keeps the term at 0 when hit does not
 * change, even on gear already over the cap.
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
	const groups = hitCap.groups ?? [{ offset: 0, share: 1 }];
	return {
		gem,
		gemHit: gemId => (gemId ? (getGem(gemId)?.stats[stat] ?? 0) : 0),
		bonus,
		bonusHit: itemId => getItem(itemId)?.socketBonus[stat] ?? 0,
		hitTerm: dH =>
			groups.reduce((sum, { offset, share }) => {
				const left = r - offset;
				return sum + w * share * (Math.min(dH, left) - Math.min(0, left));
			}, 0),
	};
}

export function greedyRepairMeta(opts: {
	items: readonly SocketedItem[];
	epWeights: EpWeights;
	allowedGems: readonly GemEntry[];
	hitCap?: HitCapBudget;
}): MetaRepairResult {
	const items = opts.items.map(it => ({
		itemId: it.itemId,
		gems: [...it.gems],
	}));

	const head = items[0];
	if (!head) {
		return { items, metaAdjusted: false, recolors: [] };
	}
	const headItem = getItem(head.itemId);
	if (!headItem?.sockets.includes(GemColor.GemColorMeta)) {
		return { items, metaAdjusted: false, recolors: [] };
	}

	const initial = metaStatus(headItem.sockets, allGemIds(items));
	if (initial.kind !== 'inactive') {
		return { items, metaAdjusted: false, recolors: [] };
	}

	const model = valueModel(opts.epWeights, opts.hitCap);
	const recolors: GemRecolor[] = [];
	const maxRecolors = 32;
	// The hit change from the gear before repair, so each move's hit is priced
	// against the budget the earlier moves left.
	let dH = 0;

	for (let i = 0; i < maxRecolors; i++) {
		const status = metaStatus(headItem.sockets, allGemIds(items));
		if (status.kind === 'active') {
			return { items, metaAdjusted: recolors.length > 0, recolors };
		}
		if (status.kind !== 'inactive') {
			throw new MetaInfeasibleError(`unexpected meta status ${status.kind}`);
		}

		const move = bestRepairMove(items, status.metaId, status.counts, opts.allowedGems, model, dH);
		if (!move) {
			throw new MetaInfeasibleError(`no legal recolor activates meta ${status.metaId} (${status.description})`);
		}

		const slot = items[move.itemIndex]!;
		const item = getItem(slot.itemId)!;
		while (slot.gems.length < item.sockets.length) slot.gems.push(0);
		slot.gems[move.socketIndex] = move.to;
		dH = move.dHAfter;
		recolors.push({
			itemId: slot.itemId,
			itemIndex: move.itemIndex,
			socketIndex: move.socketIndex,
			from: move.from,
			to: move.to,
			cost: move.cost,
		});
	}

	throw new MetaRecolorLimitExceededError('meta repair exceeded its recolor limit');
}

/**
 * The head's meta status when its meta gem is off, else undefined: the test
 * `repairMetaGems` makes first, which the ranking uses to skip a stats read when
 * repair would recolor nothing.
 */
export function inactiveMeta(items: readonly SocketedItem[]): Extract<MetaStatus, { kind: 'inactive' }> | undefined {
	const head = items[0];
	const headItem = head ? getItem(head.itemId) : undefined;
	if (!headItem?.sockets.includes(GemColor.GemColorMeta)) return undefined;
	const status = metaStatus(headItem.sockets, allGemIds(items));
	return status.kind === 'inactive' ? status : undefined;
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

export function dropUnneededRecolors(opts: {
	original: readonly SocketedItem[];
	repaired: readonly SocketedItem[];
	recolors: readonly GemRecolor[];
}): MetaRepairResult {
	const { original, repaired, recolors } = opts;
	const items = repaired.map(it => ({
		itemId: it.itemId,
		gems: [...it.gems],
	}));
	const metaItem = items.map(it => getItem(it.itemId)).find(entry => entry?.sockets.includes(GemColor.GemColorMeta));
	if (!metaItem) {
		return { items, metaAdjusted: recolors.length > 0, recolors: [...recolors] };
	}

	const survivingRecolors: GemRecolor[] = [];

	for (const recolor of recolors) {
		const slot = items[recolor.itemIndex];
		const originalGem = original[recolor.itemIndex]?.gems[recolor.socketIndex];
		const socketColor = slot && getItem(slot.itemId)?.sockets[recolor.socketIndex];
		if (!slot || slot.itemId !== recolor.itemId || !originalGem || socketColor === GemColor.GemColorMeta) {
			survivingRecolors.push(recolor);
			continue;
		}

		const before = slot.gems[recolor.socketIndex];
		slot.gems[recolor.socketIndex] = originalGem;
		const status = metaStatus(metaItem.sockets, allGemIds(items));
		if (status.kind === 'active') {
			continue;
		}
		slot.gems[recolor.socketIndex] = before ?? 0;
		survivingRecolors.push(recolor);
	}

	return {
		items,
		metaAdjusted: survivingRecolors.length > 0,
		recolors: survivingRecolors,
	};
}

/**
 * Switches an inactive meta back on with the best minimal recolor set of at most `d + 1`
 * changes, `d` being its color deficit. Past the work limit it warns once and runs
 * greedy with the same value, which always finishes.
 */
export function repairMetaGems(opts: {
	items: readonly SocketedItem[];
	epWeights: EpWeights;
	allowedGems: readonly GemEntry[];
	hitCap?: HitCapBudget;
	workLimit?: number;
}): MetaRepairResult {
	const status = inactiveMeta(opts.items);
	if (!status) {
		return {
			items: opts.items.map(it => ({ itemId: it.itemId, gems: [...it.gems] })),
			metaAdjusted: false,
			recolors: [],
		};
	}
	const deficit = metaDeficit(status.metaId, status.counts);
	const found = bestMinimalRepair({
		items: opts.items,
		weights: opts.epWeights,
		allowedGems: opts.allowedGems,
		...(opts.hitCap ? { hitCap: opts.hitCap } : {}),
		maxChanges: deficit + 1,
		...(opts.workLimit !== undefined ? { workLimit: opts.workLimit } : {}),
	});
	if (found === undefined) {
		throw new MetaInfeasibleError(`no recolor set of at most ${deficit + 1} changes activates meta ${status.metaId} (${status.description})`);
	}
	if ('overLimit' in found) {
		console.warn('[upgrades] meta repair: exact search passed its work limit, greedy used', { metaId: status.metaId, deficit, work: found.work });
		const repaired = greedyRepairMeta(opts);
		if (repaired.recolors.length === 0) return repaired;
		return dropUnneededRecolors({
			original: opts.items,
			repaired: repaired.items,
			recolors: repaired.recolors,
		});
	}
	return { items: found.items, metaAdjusted: true, recolors: found.recolors };
}

export type MinimalRepair = {
	items: SocketedItem[];
	recolors: GemRecolor[];
	/** The layout's value relative to `items`. */
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

const colorChangeKind = (dRed: number, dYellow: number, dBlue: number): number => (dRed + 1) * 9 + (dYellow + 1) * 3 + (dBlue + 1);
const NO_COLOR_CHANGE = colorChangeKind(0, 0, 0);

/**
 * The best minimal set of recolors that switches the meta on: undoing any one leaves it
 * off. Undefined when there is none. Each change places a non-meta allowed gem of another
 * color, no unique gem repeats or duplicates a worn one, and there are at most
 * `maxChanges`. The value is the gems' EP change, plus bonuses switched on, minus
 * bonuses switched off, plus the hit term of `valueModel`. Ties go to the first layout
 * in SIM_ORDER, socket and allowed-gems order.
 *
 * A dynamic program over the items that keeps the best value per state (which color
 * changes, hit change, unique gems placed). This is exact because the value is a sum
 * over items plus a term of the hit change. Past `workLimit` it returns `overLimit`.
 */
export function bestMinimalRepair(opts: {
	items: readonly SocketedItem[];
	weights: EpWeights;
	allowedGems: readonly GemEntry[];
	hitCap?: HitCapBudget;
	maxChanges: number;
	workLimit?: number;
}): MinimalRepair | { overLimit: true; work: number } | undefined {
	const original = opts.items.map(it => ({
		itemId: it.itemId,
		gems: [...it.gems],
	}));
	const headItem = getItem(original[0]?.itemId ?? 0);
	const status = headItem?.sockets.includes(GemColor.GemColorMeta) ? metaStatus(headItem.sockets, allGemIds(original)) : undefined;
	if (status?.kind !== 'inactive') {
		return { items: original, recolors: [], value: 0, work: 0 };
	}
	const metaId = status.metaId;
	const limit = opts.workLimit ?? REPAIR_SEARCH_WORK_LIMIT;
	const maxChanges = opts.maxChanges;
	const model = valueModel(opts.weights, opts.hitCap);
	const pool = repairGemPool(opts.allowedGems, model);
	const poolUnique = new Set(pool.filter(g => g.unique).map(g => g.id));
	const held = new Set(allGemIds(original));
	const base = gemColorCounts(allGemIds(original));
	const colorCache = new Map<number, GemColorCounts>();
	const colorOf = (gemId: number) => {
		let c = colorCache.get(gemId);
		if (!c) {
			c = gemColorCounts(gemId ? [gemId] : []);
			colorCache.set(gemId, c);
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
		uniquesKey: '',
		kinds: '',
		list: null,
	};
	states.set(stateKey(empty), empty);
	let work = 0;

	for (let itemIndex = 0; itemIndex < original.length; itemIndex++) {
		const slot = original[itemIndex]!;
		const item = getItem(slot.itemId);
		if (!item) continue;
		const colored: number[] = [];
		item.sockets.forEach((color, s) => {
			if (color !== GemColor.GemColorMeta) colored.push(s);
		});
		if (colored.length === 0) continue;
		const before = [...slot.gems];
		while (before.length < item.sockets.length) before.push(0);
		const matchedBefore = socketBonusActive(item.sockets, slot.gems);
		const trial = [...before];

		// Every way to recolor this item's sockets, best per state.
		const options = new Map<string, SearchState>();
		const visit = (j: number, changes: number) => {
			if (changes > maxChanges) return;
			if (j === colored.length) {
				let value = 0;
				let dRed = 0;
				let dYellow = 0;
				let dBlue = 0;
				let dH = 0;
				const kinds: string[] = [];
				const placed: number[] = [];
				const head: Change[] = [];
				for (const s of colored) {
					const from = before[s]!;
					const to = trial[s]!;
					if (from === to) continue;
					value += model.gem(to) - model.gem(from);
					dH += model.gemHit(to) - model.gemHit(from);
					const a = colorOf(from);
					const b = colorOf(to);
					const kind = colorChangeKind(b.red - a.red, b.yellow - a.yellow, b.blue - a.blue);
					if (kind === NO_COLOR_CHANGE) return;
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
				dH += ((matchedAfter ? 1 : 0) - (matchedBefore ? 1 : 0)) * model.bonusHit(slot.itemId);
				const option: SearchState = {
					value,
					dRed,
					dYellow,
					dBlue,
					changes,
					dH,
					uniques: placed,
					uniquesKey: placed.join('.'),
					kinds: kinds.sort().join(''),
					list: head.length > 0 ? { head, tail: null } : null,
				};
				const key = stateKey(option);
				const prev = options.get(key);
				if (!prev || value > prev.value) options.set(key, option);
				return;
			}
			const s = colored[j]!;
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
				if (b.uniques.length > 0 && b.uniques.some(u => a.uniques.includes(u))) {
					continue;
				}
				const uniques = b.uniques.length > 0 ? [...a.uniques, ...b.uniques].sort((x, y) => x - y) : a.uniques;
				const merged: SearchState = {
					value: a.value + b.value,
					dRed: a.dRed + b.dRed,
					dYellow: a.dYellow + b.dYellow,
					dBlue: a.dBlue + b.dBlue,
					changes: a.changes + b.changes,
					dH: a.dH + b.dH,
					uniques,
					uniquesKey: uniques.join('.'),
					kinds: (a.kinds + b.kinds).split('').sort().join(''),
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
		// The meta reads color counts only, so one change per kind is enough.
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
	const items = original.map(it => ({ itemId: it.itemId, gems: [...it.gems] }));
	const recolors: GemRecolor[] = [];
	for (const c of changes) {
		const slot = items[c.itemIndex]!;
		const item = getItem(slot.itemId)!;
		while (slot.gems.length < item.sockets.length) slot.gems.push(0);
		slot.gems[c.socketIndex] = c.to;
		recolors.push({
			itemId: slot.itemId,
			itemIndex: c.itemIndex,
			socketIndex: c.socketIndex,
			from: c.from,
			to: c.to,
			cost: model.gem(c.from) - model.gem(c.to),
		});
	}
	return { items, recolors, value: best.value, work };
}

/**
 * Per (color, hit amount), the non-unique allowed gem with the
 * highest value (the first on a tie), plus each unique gem that beats it. No other gem can
 * be in the best layout, as the meta and bonuses read color alone and the hit term reads
 * total hit.
 */
function repairGemPool(allowedGems: readonly GemEntry[], model: ValueModel): GemEntry[] {
	const groups = new Map<string, { best?: GemEntry; uniques: GemEntry[] }>();
	for (const g of allowedGems) {
		if (g.color === GemColor.GemColorMeta || g.color === GemColor.GemColorUnknown) {
			continue;
		}
		const key = `${g.color}|${model.gemHit(g.id)}`;
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

/** Hit from every gem plus every active socket bonus. */
export function layoutHitRating(items: readonly SocketedItem[], stat: Stat): number {
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
 * The cheapest recolor that lowers the deficit. Its cost is the drop in value it causes:
 * the gem's value change, plus the bonus it switches off, minus the bonus it switches on,
 * plus the hit change priced against the budget the earlier moves left.
 */
function bestRepairMove(
	items: SocketedItem[],
	metaId: number,
	beforeCounts: GemColorCounts,
	allowedGems: readonly GemEntry[],
	model: ValueModel,
	dHBefore: number,
): Move | null {
	const beforeDeficit = metaDeficit(metaId, beforeCounts);
	let best: Move | null = null;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		const slot = items[itemIndex]!;
		const item = getItem(slot.itemId);
		if (!item) continue;

		for (let socketIndex = 0; socketIndex < item.sockets.length; socketIndex++) {
			const socketColor = item.sockets[socketIndex]!;
			if (socketColor === GemColor.GemColorMeta) continue;

			const from = slot.gems[socketIndex] ?? 0;
			const matchedBefore = socketsMatch(slot.itemId, slot.gems);

			for (const candidate of allowedGems) {
				if (candidate.color === GemColor.GemColorMeta) continue;
				if (candidate.unique && alreadyHasUnique(items, candidate.id, from)) {
					continue;
				}
				if (candidate.id === from) continue;

				const trialGems = [...slot.gems];
				while (trialGems.length < item.sockets.length) trialGems.push(0);
				trialGems[socketIndex] = candidate.id;

				const trialItems = items.map((it, i) => (i === itemIndex ? { itemId: it.itemId, gems: trialGems } : it));
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
					((matchedAfter ? 1 : 0) - (matchedBefore ? 1 : 0)) * model.bonusHit(slot.itemId);
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

function alreadyHasUnique(items: readonly SocketedItem[], gemId: number, replacing: number): boolean {
	for (const it of items) {
		for (const g of it.gems) {
			if (g === gemId && g !== replacing) return true;
		}
	}
	return false;
}
