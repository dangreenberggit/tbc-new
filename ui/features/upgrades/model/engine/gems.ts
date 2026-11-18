/** The gems the engine may place, read live from `Database.getSync().getGems()`. */

import { GemColor } from '@generated/proto/common';
import { Database } from '@sim/proto/database';

export type GemColour = number;

export type GemEntry = {
	id: number;
	colour: GemColour;
	stats: number[];
	phase: number;
	/** wowsims ItemQuality: 2 uncommon, 3 rare, 4 epic. */
	quality: number;
	unique: boolean;
};

function toGemEntry(gem: { id: number; color: GemColor; stats: number[]; phase: number; quality: number; unique: boolean }): GemEntry {
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
	return gemPalette().filter(g => g.phase <= maxPhase);
}

export function gemsForQuality(palette: readonly GemEntry[], maxQuality: number): GemEntry[] {
	return palette.filter(g => {
		if (typeof g.quality !== 'number') {
			throw new Error(`gem ${g.id} has non-numeric quality (${String(g.quality)}); cannot apply the rarity cap`);
		}
		return g.quality <= maxQuality;
	});
}

/** The highest gem quality `fillEligibleGems` allows: rare. */
export const FILL_MAX_QUALITY = 3;

export function fillEligibleGems(palette: readonly GemEntry[]): readonly GemEntry[] {
	return gemsForQuality(palette, FILL_MAX_QUALITY);
}

export function findMetaGemId(gemIds: readonly number[]): number | undefined {
	for (const id of gemIds) {
		if (getGem(id)?.colour === GemColor.GemColorMeta) return id;
	}
	return undefined;
}
