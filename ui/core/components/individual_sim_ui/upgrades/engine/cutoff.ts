/**
 * PORTED verbatim from packages/core/src/cutoff.ts. Pure, no data-source
 * dependency — nothing to adapt.
 */
import type { SpecId } from "./types.js";

/**
 * Cutoff derived from the Stage 1 five-seed spread experiment
 * (docs/five-seed-spread.json, PLAN.md §10): max(3.0, 2× mean reported SE 1.678).
 *
 * That 1.678 is an `independent` SE, and it stays one now that paired
 * replication ships — the bar is intentionally on the coarse scale rather than
 * an oversight (ADR-0021). The cutoff runs *before* replication and selects
 * which rows get replicated, so deriving it from paired SEs would be circular;
 * and it asks whether a delta is distinguishable from zero at the precision the
 * whole pool was ranked at, which is the independent one.
 */
export type Cutoff = { readonly absDps: number; readonly pct: number };

export const CUTOFF: Cutoff = { absDps: 3.4, pct: 0.15 };

/**
 * Per-spec noise floor for a prospective set bonus, in DPS, derived from the
 * ranking's own per-spec cutoff. A set-bonus figure near zero is
 * indistinguishable from sim noise; only a figure strictly above this floor may
 * move anything.
 *
 * The display gate (the fork tab) and the ranking gate (`rankableSetPotential`,
 * view.ts) both obtain the floor by calling this function on the SAME frozen
 * per-spec `Cutoff` — the one carried on the `Ranking` the rows came from,
 * threaded to the row renderer as a parameter, never a live picker lookup and
 * never a state field a mid-run render lacks — so for any displayed row the two
 * layers read the same number and can never disagree: no row sorts on a bonus
 * the display hides, even while a stale ranking is on screen. A mid-run
 * skeleton row has no ranking and shows no prospective line at all.
 *
 * Derivation: `absDps` is already the per-spec 2×SE bar (`CUTOFF.absDps` = 3.4
 * ret from 2×1.678 rounded up, `CUTOFF_FERAL.absDps` = 3.6 feral from 2×1.774),
 * and a prospective set bonus folds two measured deltas, so its noise combines
 * ~sqrt(2) larger. `√2 × absDps` is that combined 2×SE bar per spec: ≈4.81 ret,
 * ≈5.09 feral. The nine untested specs inherit ret's floor via `CUTOFF_BY_SPEC`
 * (see `cutoffForSpec`), so the untested-spec debt stays annotated in one place.
 * See tickets 331 and 332, and
 * .scratch/stage-gate/ticket-332-per-spec-ranking-floor/plan.md.
 */
export function setBonusNoiseFloorDps(cutoff: Cutoff): number {
  return Math.SQRT2 * cutoff.absDps;
}

/**
 * Feral cutoff derived from its own five-seed spread
 * (docs/five-seed-spread-feral.json, issue #1 README step 0), following the
 * same method as ret's above: max(3.0, 2× mean reported SE 1.774) → 3.6.
 * Feral's rotation is noisier than ret's (mean reported SE 1.774 vs ret's
 * 1.678 at the same 5000 iterations, same fixture-derivation method), so
 * applying ret's 3.4 cutoff to feral would under-count noise as a real
 * upgrade. `CUTOFF` above is intentionally left unchanged; this is additive.
 */
export const CUTOFF_FERAL: Cutoff = { absDps: 3.6, pct: 0.15 };

/**
 * Per-spec cutoff lookup, **total** over `SpecId`.
 *
 * Totality is the point: the previous `Partial` + `?? CUTOFF` shape meant a
 * newly added spec silently inherited ret's noise floor, and nothing in the
 * type system or the output said so. A spec that has not had its own five-seed
 * spread run still gets the ret-derived numbers — there is no better value to
 * give it — but it must now say so at the point of definition, so the debt is
 * visible in a diff rather than hiding in a fallback operator.
 */
const CUTOFF_BY_SPEC: Readonly<Record<SpecId, Cutoff>> = {
  ret: CUTOFF,
  feral: CUTOFF_FERAL,

  // untested: no five-seed spread has been run for any spec below, so each
  // carries ret's derived numbers. That is the same value they would have got
  // from the old `?? CUTOFF` fallback — the difference is that the debt is
  // written down here instead of hiding in an operator. Feral's spread came
  // out 6% higher than ret's on the same method, so a noisier rotation than
  // ret's is expected to be under-filtered until measured.
  // Carry-forward: .scratch/carry-forward/issues — per-spec cutoff spreads.
  balance: CUTOFF,
  hunter: CUTOFF,
  mage: CUTOFF,
  shadow: CUTOFF,
  rogue: CUTOFF,
  ele: CUTOFF,
  enh: CUTOFF,
  warlock: CUTOFF,
  warrior: CUTOFF,
};

/**
 * The `?? CUTOFF` here is not the fallback this change set out to delete.
 * That one hid *unfilled rows in a `Partial`* — a new `SpecId` type-checked
 * while silently inheriting ret's noise floor. The Record is now total, so a
 * typed `SpecId` always hits a row and the compiler forces every new spec to
 * choose. This coalesce covers only the untyped boundary: `DetectedSpecId`
 * values like `feral-tank` that are identifiable but not rankable, which
 * `cutoff.test.ts` passes through a cast. Throwing there would turn a
 * detection edge case into a crash.
 */
export function cutoffForSpec(spec: SpecId): Cutoff {
  return CUTOFF_BY_SPEC[spec] ?? CUTOFF;
}

/**
 * Lives here rather than in `rank.ts` so that `CUTOFF` and the predicate that
 * reads it stay one definition. `rank.ts` is the only caller: the cutoff is
 * absolute, so the view carries `belowCutoff` rather than re-deriving it
 * (ADR-0020).
 */
export function meetsCutoff(
  deltaDps: number,
  deltaPct: number,
  cutoff: Cutoff
): boolean {
  return deltaDps >= cutoff.absDps || deltaPct >= cutoff.pct;
}
