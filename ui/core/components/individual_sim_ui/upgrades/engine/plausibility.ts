/**
 * Cheap sanity checks on a finished ranking.
 *
 * PORTED from packages/core/src/plausibility.ts, unchanged. Pure over
 * dead-slots.ts and rank.ts's SetBonusValue shape — no data-source
 * dependency to adapt.
 */

import {
  classifyDeadSlots,
  type ClassifyDeadSlotsOptions,
  type DeadSlotCause,
  type DeadSlotRow,
} from "./dead-slots.js";
import type { SetBonusValue } from "./rank.js";
import type { SetThreshold } from "./set-value.js";

export const IMPLAUSIBLE_BONUS_FRACTION = 0.075;

const WARNED_DEAD_SLOT_CAUSES: readonly DeadSlotCause[] = [
  "set-break-toll",
  "unique-effect",
  "unknown-item",
  "unidentified-worn-item",
];

export type ImplausibleSetBonusWarning = {
  kind: "implausible-set-bonus";
  setId: number;
  setName: string;
  threshold: SetThreshold;
  bonusDps: number;
  fractionOfBaseline: number;
  thresholdFraction: number;
  message: string;
};

export type DeadSlotWarning = {
  kind: "dead-slot";
  slot: string;
  cause: DeadSlotCause;
  wornItemName: string;
  message: string;
};

export type PlausibilityWarning = ImplausibleSetBonusWarning | DeadSlotWarning;

export type MagnitudeGateOptions = {
  baselineDps: number;
};

export function setBonusMagnitudeWarnings(
  bonuses: readonly SetBonusValue[],
  options: MagnitudeGateOptions
): ImplausibleSetBonusWarning[] {
  if (!(options.baselineDps > 0)) return [];

  const warnings: ImplausibleSetBonusWarning[] = [];
  for (const b of bonuses) {
    if (b.bonusDps === undefined || b.bonusDps === 0) continue;
    const fractionOfBaseline = b.bonusDps / options.baselineDps;
    if (Math.abs(fractionOfBaseline) <= IMPLAUSIBLE_BONUS_FRACTION) continue;
    const message =
      b.bonusDps > 0
        ? `${b.setName} ${b.threshold}pc reports ${b.bonusDps.toFixed(2)} DPS — ` +
          `~${(fractionOfBaseline * 100).toFixed(1)}% of a ${options.baselineDps.toFixed(2)} baseline, ` +
          `above the ${(IMPLAUSIBLE_BONUS_FRACTION * 100).toFixed(1)}% plausibility band. ` +
          `Treat as a suspected confound, not a bonus this large; check what the package breaks.`
        : `${b.setName} ${b.threshold}pc reports ${b.bonusDps.toFixed(2)} DPS — ` +
          `a loss of ~${(Math.abs(fractionOfBaseline) * 100).toFixed(1)}% of a ${options.baselineDps.toFixed(2)} baseline, ` +
          `outside the ${(IMPLAUSIBLE_BONUS_FRACTION * 100).toFixed(1)}% plausibility band. ` +
          `This bonus is implausibly negative; suspect a measurement problem ` +
          `(for example, a piece of the same set already worn), not a bonus that hurts this much.`;
    warnings.push({
      kind: "implausible-set-bonus",
      setId: b.setId,
      setName: b.setName,
      threshold: b.threshold,
      bonusDps: b.bonusDps,
      fractionOfBaseline,
      thresholdFraction: IMPLAUSIBLE_BONUS_FRACTION,
      message,
    });
  }
  return warnings;
}

function tieNote(tiedCandidates: number | null): string {
  if (tiedCandidates === null || tiedCandidates <= 0) return "";
  return (
    ` ${tiedCandidates} candidate${tiedCandidates === 1 ? "" : "s"} measured ` +
    `identically to the worn item and are excluded from the runner-up gap.`
  );
}

function deadSlotMessage(
  cause: DeadSlotCause,
  slot: string,
  wornItemName: string,
  setName: string | null
): string {
  if (cause === "unidentified-worn-item") {
    return (
      `No positive candidate in ${slot}, and no row records which item is worn, ` +
      `so the slot could not be classified at all. This usually means an older saved ` +
      `report that predates per-item ownership; re-run the ranking before reading anything ` +
      `into this slot.`
    );
  }
  if (cause === "set-break-toll") {
    return (
      `No positive candidate in ${slot}: every alternative displaces ${wornItemName} ` +
      `and pays ${setName ?? "its set"}'s lost bonus. Check that toll is real before trusting the slot.`
    );
  }
  if (cause === "unknown-item") {
    return (
      `No positive candidate in ${slot}, and the worn ${wornItemName} could not be resolved ` +
      `in the item index — its set membership is unknown, so why the slot is dead is unknown too. ` +
      `Check the item data before reading anything into this slot.`
    );
  }
  return (
    `No positive candidate in ${slot}: nothing in a full pool matches ${wornItemName}'s effect. ` +
    `Expected for a unique effect, but worth confirming it is not a measurement fault.`
  );
}

export function deadSlotWarnings(
  rows: readonly DeadSlotRow[],
  options: ClassifyDeadSlotsOptions
): DeadSlotWarning[] {
  return classifyDeadSlots(rows, options)
    .filter((d) => WARNED_DEAD_SLOT_CAUSES.includes(d.cause))
    .map((d) => ({
      kind: "dead-slot" as const,
      slot: d.slot,
      cause: d.cause,
      wornItemName: d.wornItemName ?? "unknown",
      message:
        deadSlotMessage(
          d.cause,
          d.slot,
          d.wornItemName ?? "unknown",
          d.wornSetName
        ) + tieNote(d.tiedCandidates),
    }));
}

export type PlausibilityInput = {
  baselineDps: number;
  setBonuses?: readonly SetBonusValue[];
  rows: readonly DeadSlotRow[];
} & ClassifyDeadSlotsOptions;

export function plausibilityWarnings(
  input: PlausibilityInput
): PlausibilityWarning[] {
  return [
    ...setBonusMagnitudeWarnings(input.setBonuses ?? [], {
      baselineDps: input.baselineDps,
    }),
    ...deadSlotWarnings(input.rows, { wornSetCounts: input.wornSetCounts }),
  ];
}
