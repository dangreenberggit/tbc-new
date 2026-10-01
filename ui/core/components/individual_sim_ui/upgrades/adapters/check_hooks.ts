/**
 * Test tooling for the partner-rule check (ticket 511, stage K5P). Not a
 * player feature.
 *
 * The tab reads `window.__upgradesCheck` only inside `__TBC_TAB_FIXTURES__`
 * branches, which exist in the dev server and the gate harness's own build and
 * never in a production build (`data/tab-fixtures/README.md`). Players never
 * set it. Undefined, or any field left undefined, means the shipped behaviour:
 * the tab's own pool and the engine's `PARTNER_RULE`.
 */

import type { PartnerRule } from '../engine/partner-choice.js';
import type { PoolEntry } from '../engine/pool.js';
import type { SetScreenMode } from '../engine/set-screen.js';
import type { ContentPhase, SpecId } from '../engine/types.js';

export type CheckHooks = {
	/** Overrides the engine's `PARTNER_RULE` for the next run. */
	partnerRule?: PartnerRule;
	/** "record" runs the set screen and writes `ranking.setScreen` (stages K5P and K5E). */
	setScreen?: SetScreenMode;
	pool?: {
		/**
		 * Entries from another spec's or phase's pool that the run's pool
		 * lacks, so a check character can be given pieces its own pool does not
		 * hold (for example last phase's best gear facing the next tier).
		 */
		addFrom?: Array<{ spec: SpecId; phase: number; itemIds: number[] }>;
		/** Keep only set pieces, so a check run sims the set rows and little else. */
		onlySetPieces?: boolean;
	};
};

declare global {
	interface Window {
		__upgradesCheck?: CheckHooks;
	}
}

/**
 * The run's pool after the check hook: the named entries the pool lacks are
 * appended, then, with `onlySetPieces`, only entries with a non-zero set id are
 * kept. Pure; the tab passes its own `poolFor` and set-id lookup.
 */
export function applyCheckPool(
	pool: readonly PoolEntry[],
	hook: CheckHooks['pool'] | undefined,
	deps: {
		poolFor: (spec: SpecId, phase: ContentPhase) => readonly PoolEntry[];
		setIdOf: (itemId: number) => number | undefined;
	},
): readonly PoolEntry[] {
	if (!hook) return pool;
	const out = [...pool];
	const have = new Set(pool.map(e => e.itemId));
	for (const add of hook.addFrom ?? []) {
		const wanted = new Set(add.itemIds);
		for (const entry of deps.poolFor(add.spec, add.phase as ContentPhase)) {
			if (!wanted.has(entry.itemId) || have.has(entry.itemId)) continue;
			out.push(entry);
			have.add(entry.itemId);
		}
	}
	return hook.onlySetPieces ? out.filter(e => (deps.setIdOf(e.itemId) ?? 0) !== 0) : out;
}
