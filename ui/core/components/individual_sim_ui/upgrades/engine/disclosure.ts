/**
 * Standing assumptions vs this-run substitutions.
 *
 * PORTED from packages/core/src/disclosure.ts, unchanged. Pure formatting
 * over `types.ts`/`caps.ts`/`meta-repair.ts` types — no data-source
 * dependency to adapt.
 */

import type { ContentPhase, Race } from "./types.js";
import type { MetaRepairSwap } from "./meta-repair.js";
import type { TalentHitAssumption } from "./caps.js";

export type StandingAssumptionId =
  | "race"
  | "talents-apl-buffs-consumes-encounter"
  | "professions-excluded"
  | "weapon-imbue-omitted";

export type StandingAssumption = {
  id: StandingAssumptionId;
  detail: string;
};

export type Assumptions = {
  maxPhase: ContentPhase;
  seeds: number[];
  iterations: number;
  race: Race;
  presetId: string;
  standing: StandingAssumption[];
};

export type Substitution = {
  field: string;
  detail: string;
};

export function buildStandingAssumptions(race: Race): StandingAssumption[] {
  return [
    {
      id: "race",
      detail: `Race assumed ${race} from the pinned preset (not readable from WCL); override via RankInput.race.`,
    },
    {
      id: "talents-apl-buffs-consumes-encounter",
      detail:
        "Talents, APL, raid buffs, consumes, and encounter come from the pinned preset/skeleton — not from the log.",
    },
    {
      id: "professions-excluded",
      detail:
        "Profession-locked gems and items are excluded; professions are not modelled from combatant info.",
    },
    {
      id: "weapon-imbue-omitted",
      detail:
        "WCL temporaryEnchant (effect id) is omitted: no effectId→itemId imbue table in db.json. Any mhImbueId pinned by the skeleton is carried unchanged into every candidate — including weapon candidates of the other stone family and off-hand items — so a weapon-slot delta is measured under the baseline's imbue rather than the candidate's (ticket 351).",
    },
  ];
}

export function hitCapBanner(hit: {
  rating: number;
  gap: number;
  capUncertainty: number;
  talentHitAssumed?: TalentHitAssumption;
}): string {
  const rounded = Math.round(Math.abs(hit.gap));
  const band = Math.round(hit.capUncertainty);
  const assumed = hit.talentHitAssumed;
  const assumption = assumed
    ? ` Assumes ${assumed.points}/${assumed.maxPoints} ${assumed.talent} — ` +
      `your logged build is not read for talents yet.`
    : "";

  if (hit.gap > 0) {
    const direction = assumed
      ? `The real shortfall could run either way.`
      : `The real shortfall may be smaller than this.`;
    return (
      `~${rounded} rating under the hit cap — ` +
      `Heroic Presence in your party would lower the cap by ~${band}. ` +
      `${direction}${assumption}`
    );
  }
  const floor = assumed
    ? `Heroic Presence would lower the cap further.`
    : `You are over by at least this much.`;
  return (
    `~${rounded} rating over the hit cap — ` +
    `Heroic Presence in your party would lower the cap by ~${band}. ` +
    `${floor}${assumption}`
  );
}

export function renderDisclosure(opts: {
  standing: readonly StandingAssumption[];
  substitutions: readonly Substitution[];
  expandStanding?: boolean;
}): string[] {
  const lines: string[] = [];
  const { standing, substitutions } = opts;

  if (opts.expandStanding) {
    lines.push(`assumptions (${standing.length}):`);
    for (const a of standing) lines.push(`  - [${a.id}] ${a.detail}`);
  } else if (standing.length > 0) {
    lines.push(
      `assumptions: ${standing.length} standing (--assumptions to expand)`
    );
  }

  if (substitutions.length > 0) {
    lines.push(`substitutions this run (${substitutions.length}):`);
    for (const s of substitutions) lines.push(`  - ${s.field}: ${s.detail}`);
  }
  return lines;
}

const CONFIDENT_PARSE = 0.9;

export function fightProvenanceLines(fight: {
  reportCode: string;
  fightId: number;
  encounterName?: string;
  route: "ranked" | "report-events";
  confidence?: number;
  salvationUptime?: number;
}): string[] {
  const where = fight.encounterName ?? `fight ${fight.fightId}`;
  const lines = [
    `gear read from ${where} (${fight.reportCode} fight ${fight.fightId}, ${fight.route} route)` +
      (fight.confidence === undefined
        ? ""
        : `, spec confidence ${(fight.confidence * 100).toFixed(0)}%`),
  ];

  const salv = fight.salvationUptime;
  const confident = (fight.confidence ?? 0) >= CONFIDENT_PARSE;
  if (salv !== undefined && salv === 0 && confident) {
    lines.push(
      `  no Blessing of Salvation on this fight — were you off-tanking, or was there no paladin? ` +
        `If you were covering a tank slot, this gear is not your DPS set and the numbers below are measured against the wrong baseline. ` +
        `Pick another fight if so.`
    );
  }
  return lines;
}

export function setPotentialDisclosureLine(): string {
  return "set potential is measured with the completion-package synergy method, shared seeds — see PLAN.md §14's 2026-08-09 amendment";
}

export function substitutionsFromMetaRepair(
  swaps: readonly MetaRepairSwap[]
): Substitution[] {
  if (swaps.length === 0) return [];
  return [
    {
      field: "gems.meta-repair",
      detail: `Meta inactive — repaired with ${swaps.length} min-EP gem swap(s): ${swaps
        .map((s) => `${s.from}→${s.to}@item ${s.itemId}`)
        .join(", ")}.`,
    },
  ];
}
