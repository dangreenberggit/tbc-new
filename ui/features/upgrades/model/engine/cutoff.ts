/**
 * PORTED from packages/core/src/cutoff.ts, adapted in comments only: the
 * `setBonusNoiseFloorDps` doc names `futureBonuses` where core names
 * `prospectiveBonusDps` (ticket 467). The code is core's.
 */

/**
 * One flat bar for every spec, in DPS only (ADR-0037, owner ruling
 * 2026-10-11). It replaces the Stage 1 dual threshold, "3.4 DPS or 0.15%"
 * for ret and "3.6 DPS or 0.15%" for feral (PLAN.md §10, ADR-0021). The 3 is a
 * deliberate rough cut against sim noise, not a measured figure: the owner
 * judged the earlier ways of deriving a bar arbitrary. Sim noise itself is
 * ticket 105.
 *
 * The cutoff still runs *before* replication and selects which rows get
 * replicated (ADR-0021), so it reads the first-seed `deltaDps` on the coarse
 * `independent` scale.
 */
export type Cutoff = { readonly absDps: number };

export const CUTOFF: Cutoff = { absDps: 3 };

/**
 * Noise floor for a prospective set bonus, in DPS, derived from the ranking's
 * cutoff. A set-bonus figure near zero is indistinguishable from sim noise;
 * only a figure strictly above this floor may move anything.
 *
 * The display gate (the fork tab) and the ranking gate (`rankableSetPotential`,
 * view.ts) both obtain the floor by calling this function on the SAME frozen
 * `Cutoff` — the one carried on the `Ranking` the rows came from, threaded to
 * the row renderer as a parameter, never a live lookup and never a state field
 * a mid-run render lacks — so for any displayed row the two layers read the
 * same number and can never disagree: no row sorts on a bonus the display
 * hides, even while a stale ranking is on screen. A mid-run skeleton row has no
 * ranking and shows no prospective line at all.
 *
 * Derivation: `√2 × absDps`. A 2pc prospective bonus folds four sims (base +
 * package + two singles), so its combined SE `sqrt(Σ se_i²)` (see `combineSe`,
 * set-value.ts) is about √2 × a single delta's SE, and `√2 × absDps` scales
 * the single-delta bar by the same factor. With the flat 3 DPS bar the floor is
 * √2 × 3 ≈ 4.24 DPS for every spec; before ADR-0037 it was ≈4.81 for ret (from
 * 3.4) and ≈5.09 for feral (from 3.6).
 *
 * This flat `√2` floor is applied to **every** prospective bonus, 2pc and 4pc
 * alike, and that is deliberate — it is a conservative-low ranking bar, not a
 * per-piece-count-tuned one. A 4pc bonus folds six sims (base + package + four
 * singles, one sample per added piece; see rank.ts where a threshold's net
 * bonus is attached as a row's `futureBonuses` entry), so its own noise is
 * about √3 × a single delta's, ~1.22× this floor. Holding 4pc bonuses to the
 * lower 2pc bar therefore *under*-filters 4pc noise in a narrow window. This is
 * the intended direction for a bar whose job is to admit rather than hide:
 * raising it would filter more real bonuses out, and the cutoff runs before
 * replication precisely to be coarse-and-inclusive (ADR-0021). Ticket 335
 * measured that no bonus in the committed `.scratch/**` fixtures fell in the
 * old ret window (4.81, 5.89); that scan has not been re-run for the 4.24 floor
 * (untested).
 *
 * See tickets 331, 332, and 335, and
 * .scratch/stage-gate/ticket-332-per-spec-ranking-floor/plan.md.
 */
export function setBonusNoiseFloorDps(cutoff: Cutoff): number {
  return Math.SQRT2 * cutoff.absDps;
}

/**
 * Lives here rather than in `rank.ts` so that `CUTOFF` and the predicate that
 * reads it stay one definition. `rank.ts` decides `belowCutoff`; the view
 * stores it rather than re-deriving it (ADR-0020), except where Set potential
 * measures a different quantity against the same bar (`view.ts`).
 */
export function meetsCutoff(deltaDps: number, cutoff: Cutoff): boolean {
  return deltaDps >= cutoff.absDps;
}
