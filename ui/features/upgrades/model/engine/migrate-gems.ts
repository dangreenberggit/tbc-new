/**
 * Move gems from a worn piece onto a candidate item the way
 * `EquippedItem.withItem` (ui/sim/proto/equipped_item.ts) does.
 *
 * `gemEligibleForSocket` repeats the one-line export of the same name in
 * ui/sim/proto/gems.ts; callers and tests import it from this module.
 */

import { GemColor } from '@generated/proto/common';

import { getGem } from './gems';
import { socketsFor } from './items';
import { gemColorMatchesSocket } from './meta';

export function migrateGemsToItem(wornGems: readonly number[], wornItemId: number, newItemId: number): number[] {
	const newSockets = socketsFor(newItemId);
	if (newSockets.length === 0) return [];

	const wornSocketCount = socketsFor(wornItemId).length;
	const source = wornGems.slice(0, wornSocketCount > 0 ? wornSocketCount : wornGems.length).filter(id => id > 0);

	const out: number[] = new Array(newSockets.length).fill(0);

	for (const gemId of source) {
		const gem = getGem(gemId);
		if (!gem) continue;

		const matchIdx = newSockets.findIndex(
			(socket, i) => out[i] === 0 && gemEligibleForSocket(gem.colour, socket) && gemColorMatchesSocket(gem.colour, socket),
		);
		if (matchIdx >= 0) {
			out[matchIdx] = gemId;
			continue;
		}

		const eligibleIdx = newSockets.findIndex((socket, i) => out[i] === 0 && gemEligibleForSocket(gem.colour, socket));
		if (eligibleIdx >= 0) out[eligibleIdx] = gemId;
	}

	return out;
}

export function gemEligibleForSocket(gemColour: number, socketColour: number): boolean {
	if (socketColour === GemColor.GemColorMeta) {
		return gemColour === GemColor.GemColorMeta;
	}
	return gemColour !== GemColor.GemColorMeta;
}
