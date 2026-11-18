/**
 * Stat-index helpers for raw stats / socketBonus arrays.
 */

import { Stat } from '@generated/proto/common';

export { Stat };

export function statAt(stats: readonly number[], stat: Stat): number {
	return stats[stat] ?? 0;
}

/**
 * `epScore`'s weights: sparse (`{"17": 0.41}`) or dense (index-aligned array).
 */
export type EpWeights = Readonly<Record<string, number>> | readonly number[];

/**
 * EP of a dense stats array under sparse (`{"17": 0.41}`) or dense weights.
 * Missing weight → 0.
 */
export function epScore(stats: readonly number[], weights: EpWeights): number {
	if (Array.isArray(weights)) {
		let total = 0;
		for (let i = 0; i < weights.length; i++) {
			total += (stats[i] ?? 0) * (weights[i] ?? 0);
		}
		return total;
	}
	let total = 0;
	for (const [k, w] of Object.entries(weights)) {
		total += (stats[Number(k)] ?? 0) * w;
	}
	return total;
}
