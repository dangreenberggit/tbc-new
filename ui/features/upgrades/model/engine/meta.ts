/**
 * Meta gem activation. The color table and the per-gem `MetaGemCondition`
 * table come from ui/sim/proto/gems.ts rather than being re-encoded here.
 */

import { GemColor } from '@generated/proto/common';
import { gemColorMatchesSocket as upstreamGemColorMatchesSocket, getMetaGemCondition } from '@sim/proto/gems';

import { getGem } from './gems';

export type GemColorCounts = { red: number; yellow: number; blue: number };

export type MetaStatus =
	| { kind: 'no-meta-socket' }
	| { kind: 'no-meta-gem' }
	| { kind: 'active'; metaId: number; counts: GemColorCounts }
	| {
			kind: 'inactive';
			metaId: number;
			counts: GemColorCounts;
			description: string;
	  };

export function gemColorMatchesSocket(gemColor: GemColor, socketColor: GemColor): boolean {
	return upstreamGemColorMatchesSocket(gemColor, socketColor);
}

/**
 * The sim's own rule (`ItemEquipmentGemAndEnchantStats`, sim/core/database.go):
 * every socket, meta included, must hold a gem whose color matches it, so an
 * empty meta socket withholds the bonus.
 */
export function socketBonusActive(sockets: readonly number[], gemIds: readonly number[]): boolean {
	if (sockets.length === 0) return true;
	if (gemIds.length < sockets.length) return false;

	for (let i = 0; i < sockets.length; i++) {
		const gem = getGem(gemIds[i] ?? 0);
		if (!gem) return false;
		if (!gemColorMatchesSocket(gem.color, sockets[i]!)) return false;
	}

	return true;
}

export function gemColorCounts(gemIds: readonly number[]): GemColorCounts {
	const colors: GemColor[] = [];
	for (const id of gemIds) {
		const gem = getGem(id);
		if (gem) colors.push(gem.color);
	}
	return {
		red: colors.filter(c => gemColorMatchesSocket(c, GemColor.GemColorRed)).length,
		yellow: colors.filter(c => gemColorMatchesSocket(c, GemColor.GemColorYellow)).length,
		blue: colors.filter(c => gemColorMatchesSocket(c, GemColor.GemColorBlue)).length,
	};
}

export function isMetaConditionMet(metaId: number, counts: GemColorCounts): boolean {
	// getMetaGemCondition throws its own "Missing meta gem condition" error, so
	// there is no need to re-wrap it.
	const cond = getMetaGemCondition(metaId);
	return cond.isMet(counts.red, counts.yellow, counts.blue);
}

/**
 * How many gems short of activation the meta is: for a compare-color
 * condition, the greater color's shortfall; otherwise the sum of each
 * color's shortfall against its minimum.
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
	return Math.max(0, cond.minRed - counts.red) + Math.max(0, cond.minYellow - counts.yellow) + Math.max(0, cond.minBlue - counts.blue);
}

function categoryCount(color: number, counts: GemColorCounts): number {
	if (color === GemColor.GemColorRed) return counts.red;
	if (color === GemColor.GemColorYellow) return counts.yellow;
	if (color === GemColor.GemColorBlue) return counts.blue;
	throw new Error(`invalid gem color for category check: ${color}`);
}

export function metaStatus(headSockets: readonly number[], gemIds: readonly number[]): MetaStatus {
	const hasMetaSocket = headSockets.includes(GemColor.GemColorMeta);
	if (!hasMetaSocket) return { kind: 'no-meta-socket' };

	const metaId = gemIds.find(id => getGem(id)?.color === GemColor.GemColorMeta);
	if (metaId == null) return { kind: 'no-meta-gem' };

	const counts = gemColorCounts(gemIds);
	const cond = getMetaGemCondition(metaId);
	if (!cond) {
		throw new Error(`missing meta gem condition for gem: ${metaId}`);
	}
	if (isMetaConditionMet(metaId, counts)) {
		return { kind: 'active', metaId, counts };
	}
	return {
		kind: 'inactive',
		metaId,
		counts,
		description: cond.description,
	};
}
