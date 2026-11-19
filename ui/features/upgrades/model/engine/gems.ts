/** The gems the engine may place, read live from `Database.getSync().getGems()`. */

import { GemColor, ItemQuality } from '@generated/proto/common';
import { Database } from '@sim/proto/database';

export type GemEntry = {
	id: number;
	color: GemColor;
	stats: number[];
	phase: number;
	quality: ItemQuality;
	unique: boolean;
};

function toGemEntry(gem: { id: number; color: GemColor; stats: number[]; phase: number; quality: number; unique: boolean }): GemEntry {
	return {
		id: gem.id,
		color: gem.color,
		stats: gem.stats,
		phase: gem.phase,
		quality: gem.quality,
		unique: gem.unique,
	};
}

export function allGems(): readonly GemEntry[] {
	return Database.getSync().getGems().map(toGemEntry);
}

export function getGem(gemId: number): GemEntry | undefined {
	const gem = Database.getSync().lookupGem(gemId);
	return gem ? toGemEntry(gem) : undefined;
}

export function gemsForPhase(maxPhase: number): GemEntry[] {
	return allGems().filter(g => g.phase <= maxPhase);
}

export function gemsForQuality(gems: readonly GemEntry[], maxQuality: number): GemEntry[] {
	return gems.filter(g => {
		if (typeof g.quality !== 'number') {
			throw new Error(`gem ${g.id} has non-numeric quality (${String(g.quality)}); cannot apply the rarity cap`);
		}
		return g.quality <= maxQuality;
	});
}

export const FILL_MAX_QUALITY = ItemQuality.ItemQualityRare;

export function fillEligibleGems(gems: readonly GemEntry[]): readonly GemEntry[] {
	return gemsForQuality(gems, FILL_MAX_QUALITY);
}

export function findMetaGemId(gemIds: readonly number[]): number | undefined {
	for (const id of gemIds) {
		if (getGem(id)?.color === GemColor.GemColorMeta) return id;
	}
	return undefined;
}
