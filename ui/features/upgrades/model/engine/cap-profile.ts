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

import type { SpellDamageBySchool } from "./seams/sim-runner";
import { Stat } from "./stats";
import type { SpecId } from "./types";

/**
 * Talent-string position of a talent.
 *
 * `treeSegment` indexes `talentsString.split("-")`; `talentIndex` indexes the
 * characters within that segment. Both follow the UI tree order that
 * wowsims-tbc-new's talent-string encoder writes, which is the tree json's
 * order — *not* necessarily the proto declaration order. Do not add an entry
 * for a new spec without reading that spec's tree json; the two orders agree
 * for ret by inspection, and that agreement is a coincidence rather than a
 * rule.
 */
export type TalentPosition = {
  readonly treeSegment: number;
  readonly talentIndex: number;
  readonly talent: string;
};

/** A hit-granting talent's position, plus what it grants. */
export type TalentHitDescriptor = TalentPosition & {
  readonly percentPerPoint: number;
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
   * How meta repair values hit gems (tickets 535 and 746). Required, so a new
   * spec must choose: a `budget` charges hit gems against
   * `hitCapPercent − (pseudo-stat hit %)`, read from `computeStats`; a
   * `fullWeight` spec counts hit at full value and the ranking says so in one
   * note. A spec gets a budget only when one pseudo-stat gives a number that
   * never undervalues hit the sim still rewards for the spells the page's
   * default rotation casts. Sources below are at fork `b603564ee`.
   *
   * Ret and feral: budget on `PseudoStatMeleeHitPercent` (12), cap 9.
   * Yellow and two-hand white attacks miss 8% minus (hit % − 1% suppression)
   * against level 73, nothing past 9% (`sim/core/target.go:385-405`,
   * `sim/core/spell_result.go:179-190`). Improved Faerie Fire is a
   * target-side `ReducedPhysicalHitTakenChance` of 3 that the read does not
   * hold (`sim/core/debuffs.go:43-44,360-369`), so `hitCapBudgetFrom`
   * subtracts it. One known limit for feral: a druid with Improved Faerie Fire
   * applies it through its own Faerie Fire (Feral) aura
   * (`sim/druid/faerie_fire.go:11,51`), which `raid.debuffs` does not show,
   * so with the raid debuff off the budget wants 3% more hit than the sim
   * needs.
   *
   * Rogue, enhancement and warrior: full weight. White swings add 19% miss
   * when the off hand has a swing speed (`sim/core/spell_outcome.go:559-566`,
   * `sim/core/attack.go:437`), and every vendored rogue, Fury and enhancement
   * set has an off hand, so a 9% budget undervalues hit for each of them and
   * a 27% budget is never reached by real gear. Arms (two-hander, no penalty)
   * shares the warrior spec id, and this table is per spec, so Arms gets the
   * note too.
   *
   * Hunter: full weight. Ranged shots skip the dual-wield penalty
   * (`sim/core/spell_outcome.go:464,480,490`), but the hunter also swings in
   * melee with its off hand from gear (`sim/hunter/hunter.go:136-143`), the
   * page's default rotation melee-weaves (`ui/specs/hunter/dps/spec.ts:85-86`,
   * `presets.ts:54-57`), and every vendored `dw_*` set has an off hand. With a
   * dual-wield set hit past 9% still cuts melee misses; with a `2h_*` set it
   * does not; one budget cannot be right for both.
   *
   * Mage, shadow and warlock: budget on `PseudoStatSpellHitPercent` (13), cap
   * 16, no Faerie Fire term (it is physical only), priced by the spells the
   * baseline sim cast (ticket 831, `HitCapBudget.groups`). Spell hit is
   * `SpellHitPercent` + the spell's own bonus + the school bonus when the
   * spell has a class mask (`sim/core/spell_result.go:241-247`), with miss
   * floored at 1% (`:250-262`). The target adds a term only to binary spells,
   * whose base hit its resistance scales (`:252-256`, and
   * `SPELL_HIT_CAP_PERCENT` below); no default target has resistances. Slot
   * 13 is the term every spell shares; the per-school slots 6-11 add the
   * school bonus (`sim/core/character_sheet.go:111-116`), which comes from
   * talents (`sim/mage/talents.go:113,536-537`, `sim/priest/talents.go:338`;
   * none for the warlock) or bonus stats. So hit is worth, for each school
   * the sim cast spells of, that school's share of the spell damage until
   * its own slot reaches 16: the page's default shadow priest, a Troll with
   * no Starshards (`sim/priest/priest.go:58-62`), casts only Shadow spells
   * and values no hit past its Shadow cap. Three estimates remain. A spell
   * with no class mask (an item proc) gets no school bonus but is priced at
   * its school's slot, which undervalues hit for its share. An explosive
   * gets 100% bonus hit (`sim/core/consumes.go:625-626`), so the player's
   * hit never changes it, but its Fire damage is priced as if it did, which
   * overvalues hit for its share; the sim result does not mark it
   * (`proto/api.proto:142-158`). A per-spell talent (`perSpellHitTalents`:
   * Suppression, Focused Power) shows in no slot and no metric, so the
   * spells it covers are priced as if it gave nothing, and the ranking says
   * so in one note.
   *
   * Elemental: full weight. Totem of Wrath, when talented, adds +3
   * `SpellHitPercent` through a buffs-phase aura
   * (`sim/shaman/talents_elemental.go:256-271`) that the stats read turns on
   * (`sim/core/character.go:475`), but in combat only while the totem is down:
   * a Fire Elemental cancels it (`sim/shaman/fire_totems.go:175-177`) for 120 s
   * (`sim/shaman/fire_elemental_totem.go:15`). So the read can hold 3% hit
   * the sim does not give, and a budget from it would undervalue hit, as for
   * balance below. Nature's Guidance also adds `SpellHitPercent`
   * (`sim/shaman/talent_restoration.go:18-30`), but permanently, so it alone
   * would not have mattered.
   *
   * Balance: full weight. Balance of Power is a per-spell bonus on Wrath,
   * Starfire and Moonfire, and while stats are measured it adds a flat +4
   * `SpellHitPercent` (`sim/druid/talents.go:139-149`); `FillPlayerStats`
   * turns on build-phase auras before it reads the pseudo-stats
   * (`sim/core/character.go:319-327,470-480`), so every spell-hit slot of a
   * Balance of Power druid holds that +4 and none gives the plain
   * "cap − hit %". Faerie Fire and Insect Swarm, which the default APL can
   * cast, are outside its mask (`ui/specs/druid/balance/apls/default.apl.json`).
   */
  readonly repair: RepairPolicy;
};

/** See `CapProfile.repair`. */
export type RepairPolicy =
  | {
      readonly kind: "budget";
      readonly hitPercentPseudoStat: number;
      /**
       * Talents that add hit to some spells only, which neither the stats
       * read nor the sim's action metrics show (ticket 831). See
       * `perSpellHitTalentTaken`.
       */
      readonly perSpellHitTalents?: readonly TalentPosition[];
    }
  | { readonly kind: "fullWeight" };

/**
 * The hit rating still useful against the cap, negative when the gear is over
 * it (ticket 535). `remaining` is for the hit every attack or spell shares,
 * the budget's pseudo-stat. A spell-hit budget also has `groups` (ticket
 * 831): the spells the baseline sim cast, grouped by how much more hit than
 * that they get (`offset`, rating), each with its share of their damage.
 * Hit is worth a group's share until `remaining − offset` is used up.
 * Absent means one group with offset 0 and share 1.
 */
export type HitCapBudget = {
  readonly stat: Stat;
  readonly remaining: number;
  readonly groups?: readonly HitCapGroup[];
};

/** See `HitCapBudget.groups`. */
export type HitCapGroup = { readonly offset: number; readonly share: number };

/** `PseudoStatMeleeHitPercent` in `ui/generated/proto/common.ts:1672`. */
const PSEUDO_STAT_MELEE_HIT_PERCENT = 12;
/** `PseudoStatSpellHitPercent` in `ui/generated/proto/common.ts:1676`. */
const PSEUDO_STAT_SPELL_HIT_PERCENT = 13;
/**
 * The school hit pseudo-stat (`PseudoStatSchoolHitPercentArcane` to
 * `...Shadow`, `ui/generated/proto/common.ts:1648-1668`) of each single magic
 * school, keyed by the sim's `SpellSchool` bit (`sim/core/flags.go:226-232`),
 * the value `ActionMetrics.spell_school` carries.
 */
const SCHOOL_HIT_PSEUDO_STAT: Readonly<Record<number, number>> = {
  64: 6, // Arcane
  4: 7, // Fire
  16: 8, // Frost
  2: 9, // Holy
  8: 10, // Nature
  32: 11, // Shadow
};
/** `SpellSchoolPhysical`, which uses melee hit, not spell hit. */
const SPELL_SCHOOL_PHYSICAL = 1;

const MELEE_HIT_BUDGET: RepairPolicy = {
  kind: "budget",
  hitPercentPseudoStat: PSEUDO_STAT_MELEE_HIT_PERCENT,
};
const SPELL_HIT_BUDGET: RepairPolicy = {
  kind: "budget",
  hitPercentPseudoStat: PSEUDO_STAT_SPELL_HIT_PERCENT,
};
/**
 * The two `SpellMod_BonusHit_Percent` talents of the spell-budget classes
 * (`grep -rn SpellMod_BonusHit_Percent sim/mage sim/priest sim/warlock`).
 * Positions follow `ui/sim/talents/trees/<class>.json`.
 */
const SHADOW_SPELL_HIT_BUDGET: RepairPolicy = {
  ...SPELL_HIT_BUDGET,
  // Smite and Mind Blast only (`sim/priest/talents.go:64-73`).
  perSpellHitTalents: [
    { treeSegment: 0, talentIndex: 15, talent: "Focused Power" },
  ],
};
const WARLOCK_SPELL_HIT_BUDGET: RepairPolicy = {
  ...SPELL_HIT_BUDGET,
  // Affliction spells only (`sim/warlock/talents.go:75-84`).
  perSpellHitTalents: [
    { treeSegment: 0, talentIndex: 0, talent: "Suppression" },
  ],
};
const FULL_WEIGHT: RepairPolicy = { kind: "fullWeight" };

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
    repair: MELEE_HIT_BUDGET,
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
    repair: MELEE_HIT_BUDGET,
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
    repair: FULL_WEIGHT,
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
    repair: FULL_WEIGHT,
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
    repair: SPELL_HIT_BUDGET,
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
    repair: SHADOW_SPELL_HIT_BUDGET,
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
    repair: FULL_WEIGHT,
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
    repair: FULL_WEIGHT,
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
    repair: FULL_WEIGHT,
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
    repair: WARLOCK_SPELL_HIT_BUDGET,
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
    repair: FULL_WEIGHT,
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
 * The repair hit budget of a character the sim read (tickets 535 and 746):
 * `(cap − Improved Faerie Fire − sim hit %) × rating per %`. `pseudoStats` is
 * the first player's `finalStats.pseudoStats` from `computeStats`, whose hit
 * percent holds every player-side source (gear, gems, bonuses, enchants, set
 * bonuses, talents, buffs). Undefined when the spec's repair is not a
 * budget, when any target is not at the level the cap holds for, or when the
 * read is not a finite number.
 *
 * Improved Faerie Fire counts only for melee-hit specs: it lowers the
 * target's `ReducedPhysicalHitTakenChance`, which spell hit never reads
 * (`sim/core/debuffs.go:43-44,360-369`, `sim/core/spell_result.go:241-262`).
 *
 * A spell-hit budget also takes `spellDamageBySchool`, a sim result's damage
 * by school (`SimObservation.spellDamageBySchool`), and gets `groups` from it
 * (ticket 831): a spell's hit is slot 13 plus its school's bonus
 * (`sim/core/spell_result.go:241-249`), which the read gives as the school's
 * slot 6-11 (`sim/core/character_sheet.go:110-116`). A two-school spell gets
 * no school bonus (`SchoolIndex`, `sim/core/flags.go:288-308`). Physical
 * damage takes no share: it uses melee hit. It throws when a spell budget has
 * no damage by school, so no caster is priced without it.
 */
export function hitCapBudgetFrom(
  profile: CapProfile,
  request: unknown,
  pseudoStats: readonly number[],
  spellDamageBySchool?: SpellDamageBySchool
): HitCapBudget | undefined {
  const { repair } = profile;
  if (repair.kind !== "budget") return undefined;
  if (!targetsAtCapLevel(request)) return undefined;
  const req = request as { raid?: { debuffs?: { faerieFire?: unknown } } };
  const hitPercent = pseudoStats[repair.hitPercentPseudoStat];
  if (typeof hitPercent !== "number" || !Number.isFinite(hitPercent)) {
    return undefined;
  }
  const faerieFire = req.raid?.debuffs?.faerieFire;
  const improved =
    faerieFire === "TristateEffectImproved" || faerieFire === 2;
  const fire =
    improved && profile.hitStat === Stat.StatMeleeHitRating
      ? IMPROVED_FAERIE_FIRE_HIT_PERCENT
      : 0;
  const remaining =
    (profile.hitCapPercent - fire - hitPercent) * profile.ratingPerPercent;
  if (!pricesHitBySpells(profile)) {
    return { stat: profile.hitStat, remaining };
  }
  if (spellDamageBySchool === undefined) {
    throw new Error(
      "the sim result has no spell damage by school, so spell hit cannot be priced"
    );
  }
  return {
    stat: profile.hitStat,
    remaining,
    groups: spellHitGroups(
      pseudoStats,
      hitPercent,
      spellDamageBySchool,
      profile.ratingPerPercent
    ),
  };
}

/**
 * Whether the request has targets and every one is at the level the caps
 * hold for, which a budget needs.
 */
export function targetsAtCapLevel(request: unknown): boolean {
  const targets =
    (request as { encounter?: { targets?: ReadonlyArray<{ level?: unknown }> } })
      .encounter?.targets ?? [];
  return (
    targets.length > 0 && targets.every((t) => t.level === RAID_BOSS_LEVEL)
  );
}

/**
 * Whether the spec's budget is on spell hit, which `hitCapBudgetFrom` prices
 * by the spells a sim result shows cast (ticket 831).
 */
export function pricesHitBySpells(profile: CapProfile): boolean {
  return (
    profile.repair.kind === "budget" &&
    profile.repair.hitPercentPseudoStat === PSEUDO_STAT_SPELL_HIT_PERCENT
  );
}

function spellHitGroups(
  pseudoStats: readonly number[],
  sharedPercent: number,
  spellDamageBySchool: SpellDamageBySchool,
  ratingPerPercent: number
): HitCapGroup[] {
  const damageByOffset = new Map<number, number>();
  let total = 0;
  for (const [key, damage] of Object.entries(spellDamageBySchool)) {
    const school = Number(key);
    if (!(damage > 0) || school === SPELL_SCHOOL_PHYSICAL) continue;
    const slot = SCHOOL_HIT_PSEUDO_STAT[school];
    const schoolPercent =
      slot === undefined ? sharedPercent : (pseudoStats[slot] ?? sharedPercent);
    const offset =
      Math.max(0, schoolPercent - sharedPercent) * ratingPerPercent;
    damageByOffset.set(offset, (damageByOffset.get(offset) ?? 0) + damage);
    total += damage;
  }
  return [...damageByOffset]
    .sort(([a], [b]) => a - b)
    .map(([offset, damage]) => ({ offset, share: damage / total }));
}

/**
 * The points in `entry`'s talent, read from a wowhead-format `talentsString`
 * (proto.Player.talents_string). 0 when there is no entry, no string, or no
 * digit at the entry's position. The same decode as `talentHitFromString` in
 * `caps.ts`, which stays as ported from core.
 */
export function talentPoints(
  talentsString: string | undefined,
  entry: TalentPosition | undefined
): number {
  if (!entry || talentsString === undefined) return 0;
  const segment = talentsString.split("-")[entry.treeSegment];
  const points = Number(segment?.charAt(entry.talentIndex) || 0);
  return Number.isFinite(points) && points > 0 ? points : 0;
}

/**
 * The first per-spell hit talent the player has points in (ticket 831), whose
 * hit the budget leaves out: neither the stats read nor the sim's action
 * metrics show it, so the spells it covers reach the cap sooner than the
 * budget counts.
 */
export function perSpellHitTalentTaken(
  profile: CapProfile,
  talentsString: string | undefined
): string | undefined {
  const { repair } = profile;
  if (repair.kind !== "budget") return undefined;
  return (repair.perSpellHitTalents ?? []).find(
    (position) => talentPoints(talentsString, position) > 0
  )?.talent;
}
