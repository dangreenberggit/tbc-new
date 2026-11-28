/**
 * A brute-force check of the exact meta repair (`model/engine/meta-repair.ts`).
 *
 * Test support, not a test file. It writes again, apart from the engine, the
 * repair's value V (`repairValue`) and the six conditions a repair must meet
 * (each stated where `bruteForceBestValue` checks it), and finds the best
 * layout by trying every one. It calls only the engine's lookups and color
 * rules (`getItem`, `getGem`, `socketBonusActive`, `gemColorCounts`,
 * `isMetaConditionMet`), passed in by the test, never the repair code it checks.
 */

import { GemColor } from '@generated/proto/common';

import type { GemEntry, getGem } from '../model/engine/gems';
import type { getItem } from '../model/engine/items';
import type { gemColorCounts, isMetaConditionMet, socketBonusActive } from '../model/engine/meta';
import type { SocketedItem } from '../model/engine/meta-repair';
import { Stat } from '../model/engine/stats';

type EpWeightRecord = Readonly<Record<string, number>>;

/** The engine functions the oracle calls, passed in by the test. */
export interface OracleEngine {
	getItem: typeof getItem;
	getGem: typeof getGem;
	socketBonusActive: typeof socketBonusActive;
	gemColorCounts: typeof gemColorCounts;
	isMetaConditionMet: typeof isMetaConditionMet;
}

export type OracleOpts = {
	/** The gear before repair, in SIM_ORDER; the head (index 0) holds the meta. */
	items: readonly SocketedItem[];
	weights: EpWeightRecord;
	allowedGems: readonly GemEntry[];
	hitBudget?: { stat: Stat; remaining: number };
	maxChanges: number;
};

/** The stat the hit term prices; melee hit rating when there is no budget. */
const MELEE_HIT_RATING = Stat.StatMeleeHitRating;

function weighted(stats: readonly number[], weights: EpWeightRecord, skip: number): number {
	let sum = 0;
	for (const [key, w] of Object.entries(weights)) {
		const index = Number(key);
		if (index === skip) continue;
		sum += (stats[index] ?? 0) * w;
	}
	return sum;
}

function itemMatched(engine: OracleEngine, itemId: number, gems: readonly number[]): boolean {
	const item = engine.getItem(itemId);
	if (!item) return true;
	return engine.socketBonusActive(item.sockets, gems);
}

/** Every gem's hit plus every active socket bonus's hit. */
function layoutHit(engine: OracleEngine, layout: readonly SocketedItem[], stat: number): number {
	let hit = 0;
	for (const it of layout) {
		const item = engine.getItem(it.itemId);
		if (!item) continue;
		for (const g of it.gems) hit += engine.getGem(g)?.stats[stat] ?? 0;
		if (itemMatched(engine, it.itemId, it.gems)) {
			hit += item.socketBonus[stat] ?? 0;
		}
	}
	return hit;
}

/**
 * V of `layout` relative to `opts.items`: the non-hit EP change of every
 * changed socket, minus each socket bonus switched off, plus each one switched
 * on, plus the hit term `w × (min(ΔH, r) − min(0, r))` with a budget or
 * `w × ΔH` without one.
 */
export function repairValue(engine: OracleEngine, opts: OracleOpts, layout: readonly SocketedItem[]): number {
	const stat = opts.hitBudget?.stat ?? MELEE_HIT_RATING;
	const nonHit = (stats: readonly number[]) => weighted(stats, opts.weights, stat);
	let v = 0;
	for (let i = 0; i < opts.items.length; i++) {
		const before = opts.items[i]!;
		const after = layout[i]!;
		const item = engine.getItem(before.itemId);
		if (!item) continue;
		for (let s = 0; s < item.sockets.length; s++) {
			const o = before.gems[s] ?? 0;
			const n = after.gems[s] ?? 0;
			if (o === n) continue;
			v += nonHit(engine.getGem(n)?.stats ?? []) - nonHit(engine.getGem(o)?.stats ?? []);
		}
		const was = itemMatched(engine, before.itemId, before.gems);
		const is = itemMatched(engine, after.itemId, after.gems);
		if (was && !is) v -= nonHit(item.socketBonus);
		if (!was && is) v += nonHit(item.socketBonus);
	}
	const w = opts.weights[String(stat)] ?? 0;
	const dH = layoutHit(engine, layout, stat) - layoutHit(engine, opts.items, stat);
	if (opts.hitBudget) {
		const r = opts.hitBudget.remaining;
		v += w * (Math.min(dH, r) - Math.min(0, r));
	} else {
		v += w * dH;
	}
	return v;
}

function allGemIds(layout: readonly SocketedItem[]): number[] {
	return layout.flatMap(it => it.gems.filter(g => g > 0));
}

/** The meta gem in the head's meta socket, or undefined. */
function metaIdOf(engine: OracleEngine, items: readonly SocketedItem[]) {
	const head = items[0];
	const item = head ? engine.getItem(head.itemId) : undefined;
	if (!head || !item) return undefined;
	const socket = item.sockets.indexOf(GemColor.GemColorMeta);
	if (socket < 0) return undefined;
	const id = head.gems[socket] ?? 0;
	return id > 0 ? id : undefined;
}

/**
 * The candidate gems for every socket. "full" is every non-meta allowed gem.
 * "reduced" is, for each (color, hit amount) group, the non-unique gem with
 * the highest non-hit EP (the first in allowed-gems order on a tie), plus each
 * unique gem whose non-hit EP beats it.
 */
export function candidatePool(opts: OracleOpts, pool: 'reduced' | 'full'): GemEntry[] {
	const colored = opts.allowedGems.filter(g => g.color !== GemColor.GemColorMeta);
	if (pool === 'full') return colored;
	const stat = opts.hitBudget?.stat ?? MELEE_HIT_RATING;
	const hitOf = (g: GemEntry) => (opts.hitBudget ? (g.stats[stat] ?? 0) : 0);
	const nonHit = (g: GemEntry) => (opts.hitBudget ? weighted(g.stats, opts.weights, stat) : weighted(g.stats, opts.weights, -1));
	const groups = new Map<string, GemEntry[]>();
	for (const g of colored) {
		const key = `${g.color}|${hitOf(g)}`;
		groups.set(key, [...(groups.get(key) ?? []), g]);
	}
	const out: GemEntry[] = [];
	for (const members of groups.values()) {
		let best: GemEntry | undefined;
		for (const g of members) {
			if (g.unique) continue;
			if (!best || nonHit(g) > nonHit(best)) best = g;
		}
		if (best) out.push(best);
		for (const g of members) {
			if (g.unique && (!best || nonHit(g) > nonHit(best))) out.push(g);
		}
	}
	return out;
}

type Socket = { item: number; socket: number };

/**
 * The highest V over every layout that changes at most `opts.maxChanges`
 * colored sockets to gems of `pool` and meets conditions 1–6, or undefined
 * when none does. `visit`, when given, sees every qualifying layout and its V.
 */
export function bruteForceBestValue(
	engine: OracleEngine,
	opts: OracleOpts,
	pool: 'reduced' | 'full',
	visit?: (layout: SocketedItem[], value: number) => void,
): number | undefined {
	const metaId = metaIdOf(engine, opts.items);
	if (metaId === undefined) return undefined;
	const gems = candidatePool(opts, pool);
	const sockets: Socket[] = [];
	for (let i = 0; i < opts.items.length; i++) {
		const item = engine.getItem(opts.items[i]!.itemId);
		if (!item) continue;
		item.sockets.forEach((color, s) => {
			if (color !== GemColor.GemColorMeta) sockets.push({ item: i, socket: s });
		});
	}
	const held = new Set(allGemIds(opts.items));
	const counts = (ids: readonly number[]) => engine.gemColorCounts(ids);
	const colorOf = (gemId: number) => counts(gemId > 0 ? [gemId] : []);
	const active = (layout: readonly SocketedItem[]) => engine.isMetaConditionMet(metaId, counts(allGemIds(layout)));

	const qualifies = (layout: SocketedItem[], changed: readonly Socket[]) => {
		const placed = new Set<number>();
		for (const c of changed) {
			const from = opts.items[c.item]!.gems[c.socket] ?? 0;
			const to = layout[c.item]!.gems[c.socket]!;
			const a = colorOf(from);
			const b = colorOf(to);
			// Condition 2: the change alters its socket's color.
			if (a.red === b.red && a.yellow === b.yellow && a.blue === b.blue) {
				return false;
			}
			// Condition 5: no unique gem the gear holds, and each placed once.
			if (engine.getGem(to)?.unique) {
				if (held.has(to) || placed.has(to)) return false;
				placed.add(to);
			}
		}
		// Condition 3: the meta is active.
		if (!active(layout)) return false;
		// Condition 4: undoing any one change leaves the meta inactive.
		for (const c of changed) {
			const undone = layout.map(it => ({ ...it, gems: [...it.gems] }));
			undone[c.item]!.gems[c.socket] = opts.items[c.item]!.gems[c.socket] ?? 0;
			if (active(undone)) return false;
		}
		return true;
	};

	let best: number | undefined;
	const chosen: Socket[] = [];
	const layout = opts.items.map(it => {
		const item = engine.getItem(it.itemId);
		const padded = [...it.gems];
		while (item && padded.length < item.sockets.length) padded.push(0);
		return { itemId: it.itemId, gems: padded };
	});

	const assign = (k: number) => {
		if (k === chosen.length) {
			if (chosen.length === 0 || !qualifies(layout, chosen)) return;
			const v = repairValue(engine, opts, layout);
			visit?.(
				layout.map(it => ({ itemId: it.itemId, gems: [...it.gems] })),
				v,
			);
			if (best === undefined || v > best) best = v;
			return;
		}
		const c = chosen[k]!;
		const from = opts.items[c.item]!.gems[c.socket] ?? 0;
		for (const g of gems) {
			// Condition 1: a non-meta allowed gem, and a change, not the same gem.
			if (g.id === from) continue;
			layout[c.item]!.gems[c.socket] = g.id;
			assign(k + 1);
		}
		layout[c.item]!.gems[c.socket] = from;
	};

	// Condition 6: every set of at most `maxChanges` sockets.
	const choose = (start: number) => {
		if (chosen.length > 0) assign(0);
		if (chosen.length === opts.maxChanges) return;
		for (let j = start; j < sockets.length; j++) {
			chosen.push(sockets[j]!);
			choose(j + 1);
			chosen.pop();
		}
	};
	choose(0);
	return best;
}
