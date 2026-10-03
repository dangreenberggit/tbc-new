/**
 * Per-spec cap descriptor — the table that lets one cap implementation serve
 * both hit schools.
 *
 * Before this file, `caps.ts` was physical-only: it summed
 * `StatMeleeHitRating`, compared it to a melee cap, and decoded ret's Precision
 * from a table living inside the module. A caster spec cannot be expressed that
 * way at all — it needs a different stat key, a different rating-per-percent
 * conversion, a different cap percentage, and no expertise line. Rather than
 * branch on the spec inside every function, each spec names its numbers here
 * once and the cap code reads them.
 *
 * The `Record<SpecId, CapProfile>` is deliberately **total**: a spec added to
 * `SpecId` without a cap profile is a compile error, which is the only thing
 * that stops a new spec silently inheriting ret's melee cap. The pre-existing
 * failure mode this replaces was quieter than a wrong number — it was a *right*
 * number for the wrong school.
 *
 * The cap percentages are game-rule constants, the same category as the melee
 * `HIT_CAP_PERCENT = 9` this repo already shipped. The sim hardcodes neither
 * (it derives miss chance from level difference), so they live here as
 * engine-owned facts with the reasoning attached rather than being read out of
 * the vendored sim at runtime.
 */

import { Stat } from "./stats.js";
import type { SpecId } from "./types.js";

/**
 * Talent-string position of a hit-granting talent, plus what it grants.
 *
 * `treeSegment` indexes `talentsString.split("-")`; `talentIndex` indexes the
 * characters within that segment. Both follow the UI tree order that
 * wowsims-tbc-new's talent-string encoder writes, which is the tree json's
 * order — *not* necessarily the proto declaration order. Do not add an entry
 * for a new spec without reading that spec's tree json; the two orders agree
 * for ret by inspection, and that agreement is a coincidence rather than a
 * rule.
 */
export type TalentHitDescriptor = {
  readonly treeSegment: number;
  readonly talentIndex: number;
  readonly percentPerPoint: number;
  readonly talent: string;
  readonly maxPoints: number;
};

/**
 * Everything the cap computation needs to know about one spec.
 *
 * `hitStat` is a real `Stat` for both schools — casters carry
 * `StatSpellHitRating` on gear, so the pseudo-stat vocabulary the fork uses for
 * EP *display* (`PseudoStatSchoolHitPercentShadow` and neighbours) never enters
 * here.
 */
export type CapProfile = {
  /** The rating stat the spec's gear uses for hit. */
  readonly hitStat: Stat;
  /** Percent of hit needed against a raid boss (level 73). */
  readonly hitCapPercent: number;
  /** Rating per one percent of hit, for this school. */
  readonly ratingPerPercent: number;
  /**
   * Whether expertise belongs in this spec's cap state. False for casters and
   * for hunters: nothing they do can be dodged or parried, so an expertise line
   * would be a field about a mechanic the spec does not have.
   */
  readonly trackExpertise: boolean;
  /** Absent when the spec's trees carry no hit talent at all. */
  readonly talentHit?: TalentHitDescriptor;
  /**
   * Present when meta repair may value hit only up to the character's
   * remaining cap, read from the sim (ticket 535). Ret and feral only:
   * dual-wield white swings miss 27% at zero hit, so hit past 9% still helps
   * them (`sim/core/spell_outcome.go:570-577`, `sim/core/attack.go:441`);
   * casters keep school hit in per-school pseudo-stats and Balance of Power is
   * a per-spell mod (`sim/core/character.go:733-739`,
   * `sim/druid/talents.go:126-138`); hunters' ranged hit is unexamined.
   *
   * One known limit for feral: a druid with Improved Faerie Fire applies it
   * through its own Faerie Fire (Feral) aura (`sim/druid/faerie_fire.go:11,51`),
   * which `raid.debuffs` does not show, so with the raid debuff off the budget
   * wants 3% more hit than the sim needs.
   */
  readonly repairCap?: { readonly hitPercentPseudoStat: number };
};

/**
 * The hit rating still useful against the cap, negative when the gear is over
 * it (ticket 535).
 */
export type HitCapBudget = { readonly stat: Stat; readonly remaining: number };

/** `PseudoStatMeleeHitPercent` in the fork's proto (`proto/common.ts`). */
const PSEUDO_STAT_MELEE_HIT_PERCENT = 12;

/**
 * Improved Faerie Fire's hit, which `computeStats` does not return: it is a
 * target-side `ReducedPhysicalHitTakenChance` (`sim/core/debuffs.go:44,365`).
 */
export const IMPROVED_FAERIE_FIRE_HIT_PERCENT = 3;

/**
 * The target level the 9% physical cap holds against: 8% miss plus 1% hit
 * suppression at level 73 (`sim/core/target.go:390-402`).
 */
export const RAID_BOSS_LEVEL = 73;

/**
 * ui/core/constants/mechanics.ts @ wowsims/tbc-new
 * 8aa378b3671a0923fd11fb34b4b3753e53f20c9b (data/wowsims.lock.json), and
 * sim/core/base_stats_auto_gen.go. Copied rather than imported: the vendor tree
 * is a build input, never a runtime dependency (PLAN.md §8.3 [S0]).
 */
export const PHYSICAL_HIT_RATING_PER_HIT_PERCENT = 15.769233;
export const SPELL_HIT_RATING_PER_HIT_PERCENT = 12.615385;

/**
 * Yellow-attack hit cap vs a level-73 boss: 9% missing. A special (yellow)
 * attack against a target three levels above the attacker misses 9% of the
 * time before hit rating.
 */
export const PHYSICAL_HIT_CAP_PERCENT = 9;

/**
 * Spell hit cap vs a level-73 boss: 16%.
 *
 * The sim models 17% base spell miss against a +3-level target
 * (`sim/core/target.go:393`, `BaseSpellMissChance` = 0.17 for level 73+ via
 * `UnitLevelFloat64`), but clamps the result to a 1% floor —
 * `math.Max(0.01, 1-hitChance)` at `sim/core/spell_result.go:246-258`. So the
 * 17th percent buys nothing and the reachable cap is 16, which is why 16 is the
 * number quoted for TBC casters. Unlike physical, there is no `HitSuppression`
 * term on spells; the 0.01 at `target.go:401` is physical-only.
 *
 * One exception the descriptor deliberately does not model: for
 * `SpellFlagBinary` spells, hit past the cap still counteracts partial resists
 * (`spell_result.go:253-255`). That is a per-spell property, not a per-spec one,
 * and this table is per-spec.
 */
export const SPELL_HIT_CAP_PERCENT = 16;

/**
 * Per-spec cap descriptors. Total over `SpecId` by construction — see the file
 * comment on why that totality is the point.
 */
export const CAP_PROFILE_BY_SPEC: Readonly<Record<SpecId, CapProfile>> = {
  /**
   * Ret's Precision is a Protection-tree talent this build cross-specs into,
   * worth 1% hit per point. paladin.proto's Protection block is talent index
   * 21-40 (`precision = 23` is local index 2); the encoder writes trees in
   * Holy(0)/Protection(1)/Retribution(2) order, so `5-053201-…` splits to Holy
   * "5" / Protection "053201" / Retribution "0523005120033125331051". Those
   * segments sum to 5/11/45, the same split asserted for this fixture at
   * `spec.test.ts:16` and `rank.test.ts:103`, which is what confirms the
   * alignment. Precision grants flat `PhysicalHitPercent`, not rating
   * (sim/paladin/talents.go applyPrecision), so the conversion goes through the
   * physical rating-per-percent.
   */
  ret: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: true,
    talentHit: {
      treeSegment: 1,
      talentIndex: 2,
      percentPerPoint: 1,
      talent: "Precision",
      maxPoints: 3,
    },
    repairCap: { hitPercentPseudoStat: PSEUDO_STAT_MELEE_HIT_PERCENT },
  },
  /**
   * Feral cat's trees carry no physical hit talent: a search of `sim/druid/`
   * finds no `PhysicalHitPercent` grant. See carry-forward ticket 05.
   */
  feral: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: true,
    repairCap: { hitPercentPseudoStat: PSEUDO_STAT_MELEE_HIT_PERCENT },
  },

  /**
   * Balance of Power, Balance tree (segment 0) index 15, 2% per point to 2
   * points (`sim/druid/talents.go:128-130`).
   *
   * Scope caveat carried for the SME gate: the sim applies it as a
   * `SpellMod_BonusHit_Percent` masked to Wrath/Starfire/Moonfire, explicitly
   * not Insect Swarm (`sim/druid/talents.go:127-128`). This table is per-spec
   * and cannot express a per-spell mask, so the cap figure treats it as global
   * — which is what the fork's own stat-weight path does too, faking a flat +4
   * `SpellHitPercent` while `Env.MeasuringStats` (`talents.go:132-137`).
   */
  balance: {
    hitStat: Stat.StatSpellHitRating,
    hitCapPercent: SPELL_HIT_CAP_PERCENT,
    ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 0,
      talentIndex: 15,
      percentPerPoint: 2,
      talent: "Balance of Power",
      maxPoints: 2,
    },
  },

  /**
   * Hunters read **melee** hit rating, not a ranged one: this sim has no
   * `StatRangedHitRating`, and `sim/core/unit.go:676-677` declares only two
   * hit-rating dependencies — `MeleeHitRating → PhysicalHitPercent` and
   * `SpellHitRating → SpellHitPercent`. Ranged attacks read
   * `PhysicalHitPercent` and add a flat `RangedHitPercent` on top
   * (`sim/core/spell_result.go:176-180`), which is a percent-only channel with
   * no rating behind it.
   *
   * Surefooted, Survival tree (segment 2) index 11, 1% per point to 3
   * (`sim/hunter/talents.go:521-526`). Animal Handler is deliberately not here:
   * its 2%/point goes to the pet, not the hunter (`talents.go:149-151`).
   *
   * No expertise: nothing a hunter fires can be dodged or parried.
   */
  hunter: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 2,
      talentIndex: 11,
      percentPerPoint: 1,
      talent: "Surefooted",
      maxPoints: 3,
    },
  },

  /**
   * Arcane Focus, Arcane tree (segment 0) index 1, 2% per point to 5
   * (`sim/mage/talents.go:112`).
   *
   * Arcane rather than Elemental Precision because every gear set this repo
   * vendors for mage is an Arcane set (`preBisArcane`/`p1Arcane`/`p2Arcane`) and
   * the fork's default EP preset is `P1 - Arcane` (`ui/mage/dps/sim.tsx:96`).
   * Elemental Precision exists at `sim/mage/talents.go:521-535` and is
   * deliberately bug-compatible — 2%/point for frost, 1%/point for fire — but a
   * per-spec table cannot hold both, and choosing the one matching the shipped
   * sets is the honest pick. Flagged to the SME gate as part of mage's stacked
   * degradations.
   */
  mage: {
    hitStat: Stat.StatSpellHitRating,
    hitCapPercent: SPELL_HIT_CAP_PERCENT,
    ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 0,
      talentIndex: 1,
      percentPerPoint: 2,
      talent: "Arcane Focus",
      maxPoints: 5,
    },
  },

  /**
   * Shadow Focus, Shadow tree (segment 2) index 4, 2% per point to 5
   * (`sim/priest/talents.go:322-327`).
   */
  shadow: {
    hitStat: Stat.StatSpellHitRating,
    hitCapPercent: SPELL_HIT_CAP_PERCENT,
    ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 2,
      talentIndex: 4,
      percentPerPoint: 2,
      talent: "Shadow Focus",
      maxPoints: 5,
    },
  },

  /**
   * Precision, Combat tree (segment 1) index 5, 1% per point to 5
   * (`sim/rogue/talents_combat.go:85-90`). The rogue `dualWieldSpecialization`
   * talent is off-hand *damage*, not hit, so it is not a hit source.
   */
  rogue: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: true,
    talentHit: {
      treeSegment: 1,
      talentIndex: 5,
      percentPerPoint: 1,
      talent: "Precision",
      maxPoints: 5,
    },
  },

  /**
   * Elemental Precision, Elemental tree (segment 0) index 14, 2% per point to 3
   * (`sim/shaman/talents_elemental.go:195-202`). Scoped to fire/frost/nature,
   * which is every school an elemental shaman casts — so unlike balance's and
   * warlock's masks, treating it as global is exact here.
   */
  ele: {
    hitStat: Stat.StatSpellHitRating,
    hitCapPercent: SPELL_HIT_CAP_PERCENT,
    ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 0,
      talentIndex: 14,
      percentPerPoint: 2,
      talent: "Elemental Precision",
      maxPoints: 3,
    },
  },

  /**
   * Dual Wield Specialization, Enhancement tree (segment 1) index 16, 2% per
   * point to 3 (`sim/shaman/talents_enhancement.go:44-72`).
   *
   * Conditional in a way this table cannot express: the sim gates it on
   * `AutoAttacks.IsDualWielding` (`:57` and `:70`), so an enhancement shaman
   * holding a two-hander gets none of it. Counting it unconditionally
   * over-credits that build by up to 6% hit. Recorded here and flagged to the
   * SME gate rather than silently dropped, because the dual-wield build is the
   * one every vendored enhancement gear set uses.
   */
  enh: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: true,
    talentHit: {
      treeSegment: 1,
      talentIndex: 16,
      percentPerPoint: 2,
      talent: "Dual Wield Specialization",
      maxPoints: 3,
    },
  },

  /**
   * Suppression, Affliction tree (segment 0) index 0, 2% per point to 5
   * (`sim/warlock/talents.go:74-83`).
   *
   * Masked to `WarlockAfflictionSpells` (`talents.go:82`), so a destruction
   * build gets no hit from it at all. Same limitation as balance's Balance of
   * Power; the fork's default EP preset is the Affli/Demo/Destro one
   * (`ui/warlock/dps/sim.ts:60`), which is the build this credits. Flagged to
   * the SME gate.
   */
  warlock: {
    hitStat: Stat.StatSpellHitRating,
    hitCapPercent: SPELL_HIT_CAP_PERCENT,
    ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: false,
    talentHit: {
      treeSegment: 0,
      talentIndex: 0,
      percentPerPoint: 2,
      talent: "Suppression",
      maxPoints: 5,
    },
  },

  /**
   * Precision, Fury tree (segment 1) index 16, 1% per point to 3
   * (`sim/warrior/talents_fury.go:320-325`). Fury is the fork's default warrior
   * variant (`ui/warrior/dps/sim.ts:63` wires `P2_FURY_EP_PRESET`).
   */
  warrior: {
    hitStat: Stat.StatMeleeHitRating,
    hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
    ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
    trackExpertise: true,
    talentHit: {
      treeSegment: 1,
      talentIndex: 16,
      percentPerPoint: 1,
      talent: "Precision",
      maxPoints: 3,
    },
  },
};

/**
 * The profile a caller with no spec in hand gets.
 *
 * Ret's, deliberately: every call site that predates this table passed no spec
 * and read the melee cap, so this keeps those readings identical rather than
 * inventing a neutral profile that would change numbers nobody asked to change.
 */
export const DEFAULT_CAP_PROFILE: CapProfile = CAP_PROFILE_BY_SPEC.ret;

/**
 * The `?? DEFAULT_CAP_PROFILE` is not the `Partial`-typed fallback this design
 * set out to delete. The Record is total, so a *typed* `SpecId` always hits a
 * row and the compiler is still the thing that forces new specs to be filled.
 * The coalesce covers the untyped path only: `DetectedSpecId` values that are
 * not rankable, and strings that reach here through a cast at a module boundary
 * — `candidate-gems.test.ts` exercises exactly that, because gem fill must
 * degrade rather than throw on a spec it does not recognise. Returning the
 * melee default there matches what that code did before this table existed.
 */
export function capProfileFor(spec: SpecId | undefined): CapProfile {
  if (spec === undefined) return DEFAULT_CAP_PROFILE;
  return CAP_PROFILE_BY_SPEC[spec] ?? DEFAULT_CAP_PROFILE;
}

/**
 * The repair hit budget of a character the sim read (ticket 535):
 * `(cap − Improved Faerie Fire − sim hit %) × rating per %`. `pseudoStats` is
 * the first player's `finalStats.pseudoStats` from `computeStats`, whose hit
 * percent holds every player-side source (gear, gems, bonuses, enchants, set
 * bonuses, talents, buffs). Undefined when the spec has no `repairCap`, when
 * any target is not at the level the cap holds for, or when the read is not
 * a finite number.
 */
export function hitCapBudgetFrom(
  profile: CapProfile,
  request: unknown,
  pseudoStats: readonly number[]
): HitCapBudget | undefined {
  if (!profile.repairCap) return undefined;
  const req = request as {
    raid?: { debuffs?: { faerieFire?: unknown } };
    encounter?: { targets?: ReadonlyArray<{ level?: unknown }> };
  };
  const targets = req.encounter?.targets ?? [];
  if (
    targets.length === 0 ||
    targets.some((t) => t.level !== RAID_BOSS_LEVEL)
  ) {
    return undefined;
  }
  const hitPercent = pseudoStats[profile.repairCap.hitPercentPseudoStat];
  if (typeof hitPercent !== "number" || !Number.isFinite(hitPercent)) {
    return undefined;
  }
  const faerieFire = req.raid?.debuffs?.faerieFire;
  const improved =
    faerieFire === "TristateEffectImproved" || faerieFire === 2;
  const fire = improved ? IMPROVED_FAERIE_FIRE_HIT_PERCENT : 0;
  return {
    stat: profile.hitStat,
    remaining:
      (profile.hitCapPercent - fire - hitPercent) * profile.ratingPerPercent,
  };
}
