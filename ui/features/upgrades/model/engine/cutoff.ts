/**
 * One flat bar for every spec, in DPS. The 3 is a deliberate rough cut
 * against sim noise, not a measured figure.
 *
 * The cutoff runs *before* replication and selects which rows get replicated,
 * so it reads the first-seed `deltaDps` on the coarse `independent` scale.
 */
export type Cutoff = { readonly absDps: number };

export const CUTOFF: Cutoff = { absDps: 3 };

/**
 * Noise floor for a four-sim prospective set bonus, in DPS, derived from the
 * ranking's cutoff. A set-bonus figure near zero is indistinguishable from sim
 * noise; only a figure strictly above this floor may move anything.
 *
 * It floors only `futureBonuses[].dps` of a ranking made without
 * `measureBrokenSetValue`, which folds four sims. The tab always sets that
 * flag (ui/features/upgrades/model/run.ts), so every set figure there is one
 * sim minus another, with the noise of one item delta; those are held to
 * `absDps` itself through `clearsSameGearGate` (set-less-copies.ts) and
 * `walkSteps` (view.ts), never to this floor.
 *
 * The display gate (the tab's popover) and the ranking gate
 * (`rankableSetPotential`, view.ts) both derive their floor from the frozen
 * `Cutoff` carried on the `Ranking` the rows came from, passed to the row
 * renderer as a parameter rather than looked up live. So no row sorts on a
 * bonus the display hides, even while a stale ranking is on screen.
 *
 * Derivation: `√2 × absDps`. A 2pc prospective bonus folds four sims (base +
 * package + two singles), so its combined SE `sqrt(Σ se_i²)` (see `combineSe`,
 * set-value.ts) is about √2 × a single delta's SE. A 4pc bonus folds six
 * (about √3 ×) but is held to the same lower bar on purpose: the bar's job is
 * to admit rather than hide, as the cutoff runs before replication to be
 * coarse and inclusive.
 */
export function setBonusNoiseFloorDps(cutoff: Cutoff): number {
  return Math.SQRT2 * cutoff.absDps;
}

/**
 * Lives here rather than in `rank.ts` so that `CUTOFF` and the predicate that
 * reads it stay one definition. `rank.ts` decides `belowCutoff`; the view
 * stores it rather than re-deriving it, except where Set potential
 * measures a different quantity against the same bar (`view.ts`).
 */
export function meetsCutoff(deltaDps: number, cutoff: Cutoff): boolean {
  return deltaDps >= cutoff.absDps;
}
