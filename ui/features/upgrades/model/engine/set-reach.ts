/**
 * Which piece counts each set can reach from the worn gear and the pool, and the checks
 * that a reach crosses a bonus (`crossingChecks`).
 */

import type { GemContext } from './candidate-gems';
import { type ChainBuild, chainSwapsWithRepairs } from './gear-swap';
import { MetaRepairError } from './meta-repair';
import { SET_BONUS_SKIP_REASONS, type SkipReason } from './run-notes';
import type { RaidSimRequest, SimRunner } from './seams/sim-runner';
import { errorText } from './set-less-copies';
import type { PlacedItem } from './set-value';
import { StopRefusedSim } from './sim-calls';
import type { SimItemSpec } from './slots';

/**
 * For each set, the piece counts above the worn count at which the sim has a
 * bonus, up to the most pieces the pool can fill (`mostAddedPieces` gives
 * those pieces). They are the bonuses the sim lists as active
 * (`<set> (<n>pc)`) with those pieces added, less those active on the current
 * gear, so no set name has to match one the tab keeps.
 *
 * When those pieces fail gem repair or a read fails, the set gets no counts:
 * no reachable bonus or `crossingChecks` entry is simmed for it, a console
 * warning names the set, and `onNotRead` gets the reason. When Stop refuses a
 * read the set gets no counts and no warning, and `rankUpgrades` drops the
 * whole set phase. A runner that cannot read bonuses gives an empty map, and
 * every count is then tried.
 */
export async function setBonusCountsInReach(
	sim: SimRunner,
	setIds: ReadonlySet<number>,
	mostAddedPieces: (setId: number) => PlacedItem[] | undefined,
	equipment: readonly SimItemSpec[],
	gems: GemContext,
	composeFor: (equipment: readonly SimItemSpec[]) => RaidSimRequest,
	onNotRead: (setId: number, reason: SkipReason) => void,
): Promise<Map<number, ReadonlySet<number>>> {
	const out = new Map<number, ReadonlySet<number>>();
	if (!sim.activeSetBonuses) return out;
	const read = (eq: readonly SimItemSpec[]) => sim.activeSetBonuses!(composeFor(eq));
	let wornNames: ReadonlySet<string> | undefined;
	for (const setId of [...setIds].sort((a, b) => a - b)) {
		const top = mostAddedPieces(setId);
		if (!top) continue;
		let build: ChainBuild;
		try {
			build = chainSwapsWithRepairs(equipment, top, gems);
		} catch (err) {
			if (!(err instanceof MetaRepairError)) throw err;
			console.warn(`[upgrades] set ${setId}: its bonus counts were not read, the added pieces' gem repair failed`, err);
			onNotRead(setId, SET_BONUS_SKIP_REASONS.metaOff(err.message));
			out.set(setId, new Set());
			continue;
		}
		try {
			wornNames ??= new Set(await read(equipment));
			const counts = new Set<number>();
			for (const name of await read(build.equipment)) {
				if (wornNames.has(name)) continue;
				const match = / \((\d+)pc\)$/.exec(name);
				if (match) counts.add(Number(match[1]));
			}
			out.set(setId, counts);
		} catch (err) {
			// A read the Stop guard refused is no failure to report.
			if (!(err instanceof StopRefusedSim)) {
				console.warn(`[upgrades] set ${setId}: its bonus counts were not read`, err);
				onNotRead(setId, SET_BONUS_SKIP_REASONS.bonusListFailed(errorText(err)));
			}
			out.set(setId, new Set());
		}
	}
	return out;
}
