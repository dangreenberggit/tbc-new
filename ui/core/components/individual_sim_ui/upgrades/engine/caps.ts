/**
 * Hit / expertise cap state.
 *
 * PORTED from packages/core/src/caps.ts, unchanged except for import paths
 * and the fork-only `gearHitRating` (ticket 535).
 * The Precision-talent hit constant and the ret talent-string decode are
 * facts about the pinned game build, not about which repo is asking, so they
 * carry over verbatim.
 */
import {
  type CapProfile,
  capProfileFor,
  PHYSICAL_HIT_CAP_PERCENT,
  PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
} from "./cap-profile.js";
import { enchantStats } from "./enchants.js";
import { getGem } from "./gems.js";
import { getItem } from "./items.js";
import { layoutHitRating, type SocketedItem } from "./meta-repair.js";
import type { SimItemSpec } from "./slots.js";
import { Stat, statAt } from "./stats.js";
import type { Race, SpecId } from "./types.js";

export {
  PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
  SPELL_HIT_RATING_PER_HIT_PERCENT,
} from "./cap-profile.js";

/**
 * Yellow-attack hit cap vs a boss (level 73): 9% missing.
 *
 * Re-exported under its original name because it predates the per-spec table
 * and callers outside this module read it. Per-spec code must go through the
 * profile — a caster's cap is 16, not 9.
 */
export const HIT_CAP_PERCENT = PHYSICAL_HIT_CAP_PERCENT;

/** ~142 rating. Ret/feral's cap; per-spec callers use `hitCapRatingFor`. */
export const HIT_CAP_RATING =
  HIT_CAP_PERCENT * PHYSICAL_HIT_RATING_PER_HIT_PERCENT;

/**
 * One percent of hit — the Heroic Presence band. Whether a Draenei is in the
 * party is not readable from WCL, so the cap is only ever known to ±1%.
 */
export const HIT_CAP_UNCERTAINTY = PHYSICAL_HIT_RATING_PER_HIT_PERCENT;

/** The spec's cap in rating: its cap percent through its own conversion. */
export function hitCapRatingFor(profile: CapProfile): number {
  return profile.hitCapPercent * profile.ratingPerPercent;
}

/**
 * The hit `stat` the equipment has: item stats, enchants, gems and active
 * socket bonuses (ticket 535). It leaves out set bonuses, which live in the
 * sim's Go code and are in no database row, so the set phase reads them from
 * the sim instead. Enchants count because a swap can drop one that does not
 * fit the new item, and ret's head enchant has 16 hit.
 */
export function gearHitRating(
  equipment: readonly SimItemSpec[],
  stat: Stat
): number {
  let hit = 0;
  for (const spec of equipment) {
    if (!spec.id) continue;
    hit += statAt(getItem(spec.id)?.stats ?? [], stat);
    if (spec.enchant) hit += statAt(enchantStats(spec.enchant), stat);
  }
  return (
    hit +
    layoutHitRating(
      equipment.map((spec) => ({ itemId: spec.id ?? 0, gems: [...(spec.gems ?? [])] })),
      stat
    )
  );
}

export type CapEntry = {
  rating: number;
  /**
   * `null` when no honest cap can be stated. Not 0: a consumer applying the
   * natural `gap <= 0 ? "capped" : "under"` test would report a player with
   * zero expertise as *at cap*, which is the most confident possible reading
   * of the least known number.
   */
  capRating: number | null;
  /** Positive when under the cap, negative when over. `null` with no cap. */
  gap: number | null;
};

/**
 * Talent hit folded into a cap figure that came from the *preset's* build
 * rather than the logged character's (carry-forward 60). Its own type because
 * it travels from the decoder through `HitCapEntry` to the banner.
 */
export type TalentHitAssumption = {
  talent: string;
  points: number;
  maxPoints: number;
};

/** Hit always has a known cap, so it narrows both nullable fields back out. */
export type HitCapEntry = CapEntry & {
  capRating: number;
  gap: number;
  assumedRace?: Race;
  /**
   * Absent means nothing was assumed — either no talent string was supplied,
   * or the spec has no hit talent to assume.
   */
  talentHitAssumed?: TalentHitAssumption;
  capUncertainty: number;
};

export type CapState = {
  hit: HitCapEntry;
  expertise: CapEntry;
};

/**
 * Sum a stat across equipped items and their socketed gems.
 *
 * `socketed` is passed separately rather than read off `equipment[].gems`
 * because meta repair rewrites gems after the equipment list is built, and the
 * repaired layout is the one the sim ran. When it is empty the equipment's own
 * gems are used.
 *
 * Both arrays are indexed **positionally** by SIM_ORDER slot, which is how
 * `applyRepairedGems` reads `socketed[i]`. Keying gems by item id instead
 * looks equivalent and is not: two identical rings or trinkets collapse to one
 * map entry, so the last one wins and is then applied to both slots. Measured
 * on two Bands of Accuria with one +8 hit gem, ground truth 48 — the id-keyed
 * version returned 40 or 56 depending purely on array order.
 */
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

/**
 * Talent-granted hit rating from a wowhead-format `talentsString`
 * (proto.Player.talents_string), decoded per the spec's `talentHit` descriptor,
 * returned alongside what it was read from so callers that must disclose the
 * assumption (carry-forward 60) do not re-decode the string themselves.
 *
 * The talent grants a flat hit *percent*, so it converts through the spec's own
 * rating-per-percent — a caster's 2%-per-point talent is worth ~25 rating, not
 * the ~32 a physical conversion would claim.
 *
 * Returns 0 rather than throwing for a spec with no mapped hit talent, a
 * string with fewer segments/characters than the mapped position, or a
 * non-digit at that position — an unreadable or absent talent contributes
 * nothing rather than crashing the cap computation over a preset detail.
 */
function talentHitFromString(
  talentsString: string,
  profile: CapProfile
): { rating: number; assumed?: TalentHitAssumption } {
  const entry = profile.talentHit;
  if (!entry) return { rating: 0 };

  const segment = talentsString.split("-")[entry.treeSegment];
  if (segment === undefined) return { rating: 0 };

  const points = Number(segment.charAt(entry.talentIndex));
  if (!Number.isFinite(points) || points <= 0) return { rating: 0 };

  return {
    rating: points * entry.percentPerPoint * profile.ratingPerPercent,
    assumed: { talent: entry.talent, points, maxPoints: entry.maxPoints },
  };
}

export function capStateFrom(
  equipment: readonly SimItemSpec[],
  socketed: readonly SocketedItem[],
  opts: { assumedRace?: Race; talentsString?: string; spec?: SpecId } = {}
): CapState {
  const profile = capProfileFor(opts.spec);
  const gearHitRating = sumStat(equipment, socketed, profile.hitStat);
  const talentHit =
    opts.talentsString !== undefined && opts.spec !== undefined
      ? talentHitFromString(opts.talentsString, profile)
      : { rating: 0 };
  const hitRating = gearHitRating + talentHit.rating;
  // A spec that cannot be dodged or parried has no expertise line to sum; the
  // entry still exists so the result stays one type, reading a flat zero.
  const expertiseRating = profile.trackExpertise
    ? sumStat(equipment, socketed, Stat.StatExpertiseRating)
    : 0;
  const capRating = hitCapRatingFor(profile);

  const hit: HitCapEntry = {
    rating: hitRating,
    capRating,
    gap: capRating - hitRating,
    capUncertainty: profile.ratingPerPercent,
  };
  if (opts.assumedRace !== undefined) hit.assumedRace = opts.assumedRace;
  if (talentHit.assumed !== undefined) hit.talentHitAssumed = talentHit.assumed;

  return {
    hit,
    expertise: {
      rating: expertiseRating,
      // The dodge cap is ~410 rating (6.5% boss dodge ÷ 0.25% per expertise
      // point × 3.942308 rating per point), but the requirement moves with
      // weapon skill — Human/Dwarf racials give +5 skill on specific weapon
      // types — and neither weapon skill nor the equipped weapon's type is
      // readable from a log. Stating a cap we cannot compute per character is
      // worse than declining to; see CapEntry on why this is null, not 0.
      capRating: null,
      gap: null,
    },
  };
}

/**
 * Per-stat delta between two equipment layouts, keyed by proto.Stat.
 *
 * Gems come from the specs themselves here rather than from a repaired layout:
 * both sides are candidate-swap equipment built by the same code path, so the
 * comparison stays like-for-like.
 */
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
 * Dense stat-array width, derived from the generated `Stat` enum rather than
 * hardcoded. `scripts/generate_item_gem_index.py` parses `NextIndex` out of
 * common.proto and refuses to run if the enum grew; hardcoding 42 here would
 * re-introduce on the TS side exactly the drift the generator now rejects —
 * a grown enum would fail loudly in Python and silently truncate this loop.
 */
const STAT_COUNT =
  Math.max(
    ...Object.values(Stat).filter((v): v is Stat => typeof v === "number")
  ) + 1;

/**
 * Simple majority. Nothing in TBC makes 0.5 special — it is the threshold that
 * needs no defending, and the flag is advisory rather than binding on the
 * ranking, so a sharper number would imply precision this does not have.
 */
const HIT_DRIVEN_SHARE = 0.5;

/**
 * Survival stats are excluded from the share, not merely down-weighted.
 *
 * Armour dwarfs every damage stat on an armoured slot: Crystalforge
 * Breastplate's delta is `{str 56, sta 40, int 20, hit 23, crit 21, armor
 * 1668}`, so counting armour puts hit at 1.3% of the "gain" and the flag can
 * never fire outside a zero-armour trinket. Excluding it puts hit at 14%,
 * which is a number about damage — the only thing this flag claims to describe.
 */
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

/**
 * §4 is explicit that not modelling stat combinations is *correct* per §2's
 * scoping rule. This flag exists because correct-but-misleading is still
 * misleading: an item that ranks purely on hit stops being an upgrade the
 * moment the player crosses the cap by any other means.
 */
export function isHitDriven(
  statDelta: Readonly<Record<number, number>>,
  hit: { gap: number },
  candidate: { deltaDps: number },
  spec?: SpecId
): boolean {
  const hitStat = capProfileFor(spec).hitStat;
  // A loss has no gain to be driven by, and the warning this flag gives —
  // "this stops being an upgrade past the cap" — says nothing about an item
  // that is not an upgrade now. Without this, below-cutoff items with negative
  // deltas get labelled as hit-driven gains.
  if (candidate.deltaDps <= 0) return false;
  if (hit.gap <= 0) return false;
  let hitGain = 0;
  let totalGain = 0;
  for (const [index, value] of Object.entries(statDelta)) {
    if (value <= 0) continue;
    if (!CONTRIBUTES_TO_DAMAGE(Number(index))) continue;
    totalGain += value;
    if (Number(index) === hitStat) hitGain += value;
  }
  if (totalGain <= 0) return false;
  return hitGain / totalGain > HIT_DRIVEN_SHARE;
}

/**
 * The mirror of `isHitDriven`: a recommendation that *reduces* hit while the
 * report is telling the player they are short of the cap.
 *
 * `isHitDriven` cannot express this — it sums only positive deltas, so an item
 * carrying no hit over a worn item carrying some scores zero hit gain and is
 * simply unflagged. That left the shortlist widening the very gap the hit
 * banner above it had just called the player's main problem, with nothing on
 * the row saying so (carry-forward 47 §2).
 *
 * Advisory only, exactly like `isHitDriven`: the sim result stands, and a
 * hit-losing item can still be the biggest throughput win. The claim is about
 * a trade the page was making silently, not about the ranking being wrong.
 */
export function hitRegression(
  statDelta: Readonly<Record<number, number>>,
  hit: { gap: number },
  candidate: { deltaDps: number },
  spec?: SpecId
): { lost: number; gapAfter: number } | null {
  if (candidate.deltaDps <= 0) return null;
  if (hit.gap <= 0) return null;
  const delta = statDelta[capProfileFor(spec).hitStat] ?? 0;
  if (delta >= 0) return null;
  const lost = -delta;
  return { lost, gapAfter: hit.gap + lost };
}
