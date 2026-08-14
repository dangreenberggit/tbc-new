/**
 * PORTED verbatim from packages/core/src/cutoff.ts. Pure, no data-source
 * dependency — nothing to adapt.
 */
import type { SpecId } from "./types.js";

export type Cutoff = { readonly absDps: number; readonly pct: number };

export const CUTOFF: Cutoff = { absDps: 3.4, pct: 0.15 };

export const CUTOFF_FERAL: Cutoff = { absDps: 3.6, pct: 0.15 };

const CUTOFF_BY_SPEC: Partial<Record<SpecId, Cutoff>> = {
  ret: CUTOFF,
  feral: CUTOFF_FERAL,
};

export function cutoffForSpec(spec: SpecId): Cutoff {
  return CUTOFF_BY_SPEC[spec] ?? CUTOFF;
}

export function meetsCutoff(
  deltaDps: number,
  deltaPct: number,
  cutoff: Cutoff
): boolean {
  return deltaDps >= cutoff.absDps || deltaPct >= cutoff.pct;
}
