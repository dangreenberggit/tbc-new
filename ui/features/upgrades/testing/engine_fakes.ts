/**
 * Stand-ins for engine tests that run `rankUpgrades` against a fake sim. Each module that
 * imports this also mocks `@sim/proto/database` with `database_mock.ts`, since `getItem` reads
 * through `Database.getSync()`.
 */

import { getItem } from '../model/engine/items';
import type { PlayerStatsObservation } from '../model/engine/seams/sim-runner';
import type { EpWeights } from '../model/engine/stats';
import { epScore } from '../model/engine/stats';

/**
 * A candidate-order score for `Deps.itemEp`: item stats times `weights`, with no credit for
 * weapon damage. The tab passes wowsims' weapon-aware score (`model/item_ep.ts`); a test that
 * passes this one gets a candidate order read off the item stats alone, so its expected order
 * does not move when the weapon model does.
 */
export const statsOnlyItemEp =
	(weights: EpWeights) =>
	(itemId: number): number =>
		epScore(getItem(itemId)?.stats ?? [], weights);

/**
 * A `SimRunner.computeStats` for fakes whose runs need no hit cap: every hit slot reads 0%, so
 * a spec with a hit budget gets the whole cap as its budget.
 */
export const zeroHitStats = (): Promise<PlayerStatsObservation> => Promise.resolve({ stats: [], pseudoStats: new Array<number>(25).fill(0) });
