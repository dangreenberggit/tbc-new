/**
 * Hit / expertise cap state.
 *
 * PORTED from packages/core/src/caps.ts, unchanged except for import paths.
 * The Precision-talent hit constant and the ret talent-string decode are
 * facts about the pinned game build, not about which repo is asking, so they
 * carry over verbatim.
 */

import { getItem } from "./items.js";
import { getGem } from "./gems.js";
import type { SimItemSpec } from "./slots.js";
import type { SocketedItem } from "./meta-repair.js";
import { Stat, statAt } from "./stats.js";
import type { Race, SpecId } from "./types.js";

export const PHYSICAL_HIT_RATING_PER_HIT_PERCENT = 15.769233;

export const HIT_CAP_PERCENT = 9;

export const HIT_CAP_RATING =
  HIT_CAP_PERCENT * PHYSICAL_HIT_RATING_PER_HIT_PERCENT;

export const HIT_CAP_UNCERTAINTY = PHYSICAL_HIT_RATING_PER_HIT_PERCENT;

export type CapEntry = {
  rating: number;
  capRating: number | null;
  gap: number | null;
};

export type TalentHitAssumption = {
  talent: string;
  points: number;
  maxPoints: number;
};

export type HitCapEntry = CapEntry & {
  capRating: number;
  gap: number;
  assumedRace?: Race;
  talentHitAssumed?: TalentHitAssumption;
  capUncertainty: number;
};

export type CapState = {
  hit: HitCapEntry;
  expertise: CapEntry;
};

function sumStat(
  equipment: readonly SimItemSpec[],
  socketed: readonly SocketedItem[],
  stat: Stat
): number {
  let total = 0;

  for (let i = 0; i < equipment.length; i++) {
    const spec = equipment[i]!;
    if (!spec.id) continue;
    total += statAt(getItem(spec.id)?.stats ?? [], stat);

    const repaired = socketed[i];
    const gems =
      repaired && repaired.itemId === spec.id ? repaired.gems : spec.gems;
    for (const gemId of gems) {
      if (!gemId) continue;
      total += statAt(getGem(gemId)?.stats ?? [], stat);
    }
  }
  return total;
}

const TALENT_HIT_BY_SPEC: Readonly<
  Record<
    SpecId,
    | {
        treeSegment: number;
        talentIndex: number;
        percentPerPoint: number;
        talent: string;
        maxPoints: number;
      }
    | undefined
  >
> = {
  ret: {
    treeSegment: 1,
    talentIndex: 2,
    percentPerPoint: 1,
    talent: "Precision",
    maxPoints: 3,
  },
  feral: undefined,
};

function talentHitFromString(
  talentsString: string,
  spec: SpecId
): { rating: number; assumed?: TalentHitAssumption } {
  const entry = TALENT_HIT_BY_SPEC[spec];
  if (!entry) return { rating: 0 };

  const segment = talentsString.split("-")[entry.treeSegment];
  if (segment === undefined) return { rating: 0 };

  const points = Number(segment.charAt(entry.talentIndex));
  if (!Number.isFinite(points) || points <= 0) return { rating: 0 };

  return {
    rating:
      points * entry.percentPerPoint * PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    assumed: { talent: entry.talent, points, maxPoints: entry.maxPoints },
  };
}

export function capStateFrom(
  equipment: readonly SimItemSpec[],
  socketed: readonly SocketedItem[],
  opts: { assumedRace?: Race; talentsString?: string; spec?: SpecId } = {}
): CapState {
  const gearHitRating = sumStat(equipment, socketed, Stat.StatMeleeHitRating);
  const talentHit =
    opts.talentsString !== undefined && opts.spec !== undefined
      ? talentHitFromString(opts.talentsString, opts.spec)
      : { rating: 0 };
  const hitRating = gearHitRating + talentHit.rating;
  const expertiseRating = sumStat(
    equipment,
    socketed,
    Stat.StatExpertiseRating
  );

  const hit: HitCapEntry = {
    rating: hitRating,
    capRating: HIT_CAP_RATING,
    gap: HIT_CAP_RATING - hitRating,
    capUncertainty: HIT_CAP_UNCERTAINTY,
  };
  if (opts.assumedRace !== undefined) hit.assumedRace = opts.assumedRace;
  if (talentHit.assumed !== undefined) hit.talentHitAssumed = talentHit.assumed;

  return {
    hit,
    expertise: {
      rating: expertiseRating,
      capRating: null,
      gap: null,
    },
  };
}

export function statDeltaBetween(
  before: readonly SimItemSpec[],
  after: readonly SimItemSpec[]
): Record<number, number> {
  const delta: Record<number, number> = {};
  for (let stat = 0; stat < STAT_COUNT; stat++) {
    const diff = sumStat(after, [], stat) - sumStat(before, [], stat);
    if (diff !== 0) delta[stat] = diff;
  }
  return delta;
}

/**
 * Dense stat-array width. packages/core derives this from its generated
 * `Stat` enum with a Python-side `NextIndex` guard (its stats.ts comment).
 * This fork has no such generator; `Stat` here is the fork's own generated
 * proto enum, which is regenerated from the same wowsims common.proto by
 * `make proto` — so a grown enum is caught by the fork's own proto pipeline,
 * not by this file needing its own guard.
 */
const STAT_COUNT =
  Math.max(
    ...Object.values(Stat).filter((v): v is Stat => typeof v === "number")
  ) + 1;

const HIT_DRIVEN_SHARE = 0.5;

const SURVIVAL_STATS = new Set<number>([
  Stat.StatStamina,
  Stat.StatArmor,
  Stat.StatBonusArmor,
  Stat.StatHealth,
  Stat.StatDefenseRating,
  Stat.StatDodgeRating,
  Stat.StatParryRating,
  Stat.StatBlockRating,
  Stat.StatBlockValue,
  Stat.StatResilienceRating,
]);

const CONTRIBUTES_TO_DAMAGE = (stat: number): boolean =>
  !SURVIVAL_STATS.has(stat);

export function isHitDriven(
  statDelta: Readonly<Record<number, number>>,
  hit: { gap: number },
  candidate: { deltaDps: number }
): boolean {
  if (candidate.deltaDps <= 0) return false;
  if (hit.gap <= 0) return false;
  let hitGain = 0;
  let totalGain = 0;
  for (const [index, value] of Object.entries(statDelta)) {
    if (value <= 0) continue;
    if (!CONTRIBUTES_TO_DAMAGE(Number(index))) continue;
    totalGain += value;
    if (Number(index) === Stat.StatMeleeHitRating) hitGain += value;
  }
  if (totalGain <= 0) return false;
  return hitGain / totalGain > HIT_DRIVEN_SHARE;
}

export function hitRegression(
  statDelta: Readonly<Record<number, number>>,
  hit: { gap: number },
  candidate: { deltaDps: number }
): { lost: number; gapAfter: number } | null {
  if (candidate.deltaDps <= 0) return null;
  if (hit.gap <= 0) return null;
  const delta = statDelta[Stat.StatMeleeHitRating] ?? 0;
  if (delta >= 0) return null;
  const lost = -delta;
  return { lost, gapAfter: hit.gap + lost };
}
