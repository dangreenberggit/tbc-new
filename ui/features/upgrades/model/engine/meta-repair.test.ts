import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GemColor } from '@generated/proto/common';
import { describe, expect, it, vi } from 'vitest';

import {
	BOLD,
	CAPPED_CHESTS,
	changesBetween,
	CHEST,
	holdsGem,
	INSCRIBED,
	metaOf,
	NIGHTSEYE,
	pairsOf,
	RAGESTEEL_BREASTPLATE,
	RAGESTEEL_SHOULDERS,
	retCapped,
	retInputs,
	RIGID,
	SHOULDER,
	UNCAPPED_CHESTS,
	WRIST,
} from '../../testing/meta_repair_inputs';
import { epWeightsFor } from '../data/data';
import { gemContext } from './candidate-gems';
import { candidateSwapPreRepair, candidateSwapWithRepairs } from './gear-swap';
import { gemsForPhase } from './gems';
import { getItem } from './items';
import { bestMinimalRepair, REPAIR_SEARCH_WORK_LIMIT, repairMetaGems, type SocketedItem } from './meta-repair';
import { Stat } from './stats';

vi.mock('@sim/proto/database', importOriginal => import('../../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));

const BOOTS = 30104;
const BELT = 30106;
const SHOULDER_30055 = 30055;

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
// Read from disk because ui/features may not import ui/specs (`.oxlintrc.json`).
const rogueP2 = JSON.parse(readFileSync(path.join(FORK_ROOT, 'ui/specs/rogue/dps/gear_sets/p2.gear.json'), 'utf8')) as {
	items: ReadonlyArray<{ id?: number; gems?: readonly number[] }>;
};

/**
 * The rogue P2 preset gear with colored gems removed in slot order, then socket
 * order, skipping a removal that would take the meta's deficit past `target`,
 * until the deficit is `target`.
 */
function rogueAtDeficit(target: number) {
	const items: SocketedItem[] = rogueP2.items.map(it => ({
		itemId: it.id ?? 0,
		gems: [...(it.gems ?? [])],
	}));
	let removed = 0;
	outer: for (const it of items) {
		const item = getItem(it.itemId);
		if (!item) continue;
		for (let s = 0; s < it.gems.length; s++) {
			if (item.sockets[s] === GemColor.GemColorMeta || !it.gems[s]) continue;
			if (metaOf(items).deficit === target) break outer;
			const kept = it.gems[s]!;
			it.gems[s] = 0;
			if (metaOf(items).deficit > target) it.gems[s] = kept;
			else removed += 1;
		}
	}
	return { items, removed, deficit: metaOf(items).deficit };
}

describe('exact repair', () => {
	it('a chest candidate over the cap gets two Inscribed Noble Topaz and no Rigid Dawnstone', () => {
		// Oracle: Inscribed was the best measured alternative on all four rows,
		// and the credited optimum.
		const { equipment, capped } = retCapped();
		for (const { itemId } of CAPPED_CHESTS) {
			const out = candidateSwapWithRepairs(equipment, CHEST, itemId, capped).equipment;
			const changes = changesBetween(equipment, out, CHEST);
			expect([itemId, pairsOf(changes)]).toEqual([itemId, [`${BOLD}->${INSCRIBED}`, `${BOLD}->${INSCRIBED}`]]);
			expect(holdsGem(out, RIGID)).toBe(false);
		}
	});

	it('a chest candidate under the cap keeps two Rigid Dawnstones', () => {
		// Oracle: Rigid beat every alternative by 17.1–19.8 DPS on these rows.
		const { equipment, capped } = retCapped();
		for (const itemId of UNCAPPED_CHESTS) {
			const out = candidateSwapWithRepairs(equipment, CHEST, itemId, capped).equipment;
			expect([itemId, pairsOf(changesBetween(equipment, out, CHEST))]).toEqual([itemId, [`${BOLD}->${RIGID}`, `${BOLD}->${RIGID}`]]);
		}
	});

	it("with no budget, Heartshatter's repair is two Rigid Dawnstones", () => {
		// Oracle: at full weight Rigid gains 9.2 EP over Bold, more than any other
		// rare gem that adds yellow.
		const { equipment, gems } = retInputs();
		const out = candidateSwapWithRepairs(equipment, CHEST, 32365, gems).equipment;
		expect(pairsOf(changesBetween(equipment, out, CHEST))).toEqual([`${BOLD}->${RIGID}`, `${BOLD}->${RIGID}`]);
	});

	it("the budget caps the layout's total hit: Burning Rage's package gets one Rigid and one Inscribed", () => {
		// remaining = −4.69 − (38 − 52) = 9.31: two Rigid score 4.02, one of each
		// 8.28, two Inscribed −1.84 (V, as `testing/meta_repair_oracle.ts` defines
		// it). One of each was also the best measured set-less layout.
		const { equipment, capped } = retCapped();
		const shoulders = candidateSwapWithRepairs(equipment, SHOULDER, RAGESTEEL_SHOULDERS, capped).equipment;
		expect(changesBetween(equipment, shoulders, SHOULDER)).toEqual([]);
		const pkg = candidateSwapWithRepairs(shoulders, CHEST, RAGESTEEL_BREASTPLATE, capped).equipment;
		expect(pairsOf(changesBetween(shoulders, pkg, CHEST))).toEqual([`${BOLD}->${RIGID}`, `${BOLD}->${INSCRIBED}`]);
	});

	it('a recolor that switches a socket bonus on earns it: the Nightseye goes to the boots or the belt, not the shoulder', () => {
		// Oracle: Sovereign Nightseye is purple, so in boots 30104 socket 0 or
		// belt 30106 socket 1 it switches on that item's +3 Agility bonus. A
		// greedy repair puts it in 30055.
		const { equipment, capped } = retCapped();
		const out = candidateSwapWithRepairs(equipment, WRIST, 32574, capped).equipment;
		const changes = changesBetween(equipment, out, WRIST);
		expect(pairsOf(changes)).toEqual([`${BOLD}->${NIGHTSEYE}`]);
		const where = `${changes[0]![0]}:${changes[0]![1]}`;
		expect([`${BOOTS}:0`, `${BELT}:1`]).toContain(where);
		expect(where.startsWith(`${SHOULDER_30055}:`)).toBe(false);
	});

	it('a deficit of 6 stays under the work limit, and past a small limit repair falls back to greedy with one warning', () => {
		// Oracle: a probe removed 12 gems to reach deficit 6, counted 546,669
		// work there, and greedy with the credit activated the meta.
		const { items, deficit } = rogueAtDeficit(6);
		expect(deficit).toBe(6);
		const ctx = gemContext(gemsForPhase(2), epWeightsFor('rogue'), 'rogue');
		const found = bestMinimalRepair({
			items,
			weights: ctx.weights,
			allowedGems: ctx.fillGems,
			maxChanges: 7,
		});
		expect(found).toBeDefined();
		expect(found && 'overLimit' in found).toBe(false);
		expect(found!.work).toBeLessThanOrEqual(REPAIR_SEARCH_WORK_LIMIT);

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const repaired = repairMetaGems({
				items,
				epWeights: ctx.weights,
				allowedGems: ctx.fillGems,
				workLimit: 1000,
			});
			expect(metaOf(repaired.items).status.kind).toBe('active');
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]![0])).toMatch(/^\[upgrades\] meta repair: exact search passed its work limit/);
		} finally {
			warn.mockRestore();
		}
	}, 30_000);
});

describe('repair matches brute force', () => {
	it('the search places only changes the meta needs', () => {
		// Oracle: a third Bold → Rigid would add 9.2 EP at full weight, but the
		// meta does not need it, so a minimal set excludes it.
		const { equipment, gems } = retInputs();
		const pre = candidateSwapPreRepair(equipment, CHEST, 32365, gems);
		const found = bestMinimalRepair({
			items: pre.socketed,
			weights: gems.weights,
			allowedGems: gems.fillGems,
			hitBudget: { stat: Stat.StatMeleeHitRating, remaining: 93 },
			maxChanges: 3,
		});
		expect(found !== undefined && !('overLimit' in found)).toBe(true);
		const changes = found !== undefined && !('overLimit' in found) ? found.recolors : [];
		expect(changes.map(c => `${c.from}->${c.to}`).sort()).toEqual([`${BOLD}->${RIGID}`, `${BOLD}->${RIGID}`]);
	});
});
