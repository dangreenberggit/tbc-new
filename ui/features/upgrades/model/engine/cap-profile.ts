/**
 * Hit and expertise cap numbers per spec, used by `gemFillWeights` and by meta
 * repair (`meta-repair.ts`, which recolors gems to turn an inactive meta gem
 * back on) so that neither branches on the spec.
 *
 * `CAP_PROFILE_BY_SPEC` must list every `SpecId`: a new spec without an entry
 * fails to compile instead of quietly getting ret's melee cap. The sim works out
 * miss chance from the level difference and has no cap constant, so the cap
 * percentages live here.
 */

import { PseudoStat } from '@generated/proto/common';

import type { SpellDamageBySchool } from './seams/sim-runner';
import { Stat } from './stats';
import type { SpecId } from './types';

/**
 * Where a talent sits in a talent string: `treeSegment` indexes
 * `talentsString.split("-")`, `talentIndex` the characters in that segment.
 * Both follow the order of the talent tree files
 * (`ui/sim/talents/trees/<class>.json`), which can differ from the proto order,
 * so check that file before adding an entry.
 */
export type TalentPosition = {
	readonly treeSegment: number;
	readonly talentIndex: number;
	readonly talent: string;
};

/**
 * What `gemFillWeights` and meta repair need to know about one spec's hit and
 * expertise caps. `hitStat` is a gear `Stat` for melee and casters alike
 * (casters carry `StatSpellHitRating`), not a pseudo-stat.
 */
export type CapProfile = {
	/** The rating stat the spec's gear uses for hit. */
	readonly hitStat: Stat;
	/** Percent of hit needed against a raid boss (level 73). */
	readonly hitCapPercent: number;
	/** Rating per one percent of hit, for this school. */
	readonly ratingPerPercent: number;
	/**
	 * When true, `gemFillWeights` gives expertise no weight. False for casters,
	 * whose spells cannot be dodged or parried, and for hunters, whose ranged
	 * shots cannot be.
	 */
	readonly hasExpertiseCap: boolean;
	/**
	 * How meta repair values hit gems; every spec must pick one. `budget` values
	 * hit only up to the cap, from the hit percent `computeStats` reports.
	 * `fullWeight` values hit at full EP, and the ranking shows a note saying so.
	 * A spec gets `budget` only when that hit percent never makes hit look worth
	 * less than the sim finds it for the default rotation's spells.
	 *
	 * Ret and feral use melee hit; mage, shadow and warlock use spell hit, split
	 * by the spell schools the baseline sim cast (`HitCapBudget.groups`). The rest
	 * use `fullWeight`. Rogue, enhancement, warrior (Arms shares the spec id) and
	 * melee-weaving hunter presets dual-wield, which adds 19% miss to white swings
	 * (`sim/core/spell_outcome.go`). For elemental and balance, `computeStats`
	 * includes hit from Totem of Wrath or Balance of Power that not every spell
	 * gets in combat. Known errors: a feral's own Improved Faerie Fire is not in
	 * `raid.debuffs`, and item procs and explosives are valued with their school's
	 * hit although their own hit differs.
	 */
	readonly repair: RepairPolicy;
};

/** See `CapProfile.repair`. */
export type RepairPolicy =
	| {
			readonly kind: 'budget';
			readonly hitPercentPseudoStat: number;
			/**
			 * Talents that add hit to some spells only. Neither `computeStats` nor
			 * the sim's action metrics show it; see `perSpellHitTalentTaken`.
			 */
			readonly perSpellHitTalents?: readonly TalentPosition[];
	  }
	| { readonly kind: 'fullWeight' };

/**
 * The hit rating still useful before the cap, negative when the gear is over
 * it. `remaining` covers the hit every attack or spell shares. For spell hit,
 * `groups` splits the spells the baseline sim cast by how much extra hit their
 * school gives (`offset`, in rating), each with its share of the damage. Hit is
 * worth a group's share until `remaining − offset` is used up. Without `groups`,
 * all damage is one group with offset 0.
 */
export type HitCapBudget = {
	readonly stat: Stat;
	readonly remaining: number;
	readonly groups?: readonly HitCapGroup[];
};

/** See `HitCapBudget.groups`. */
export type HitCapGroup = { readonly offset: number; readonly share: number };

/** Keyed by the sim's `SpellSchool` bit (`sim/core/flags.go`), the value `ActionMetrics.spell_school` carries. */
const SCHOOL_HIT_PSEUDO_STAT: Readonly<Record<number, number>> = {
	64: PseudoStat.PseudoStatSchoolHitPercentArcane,
	4: PseudoStat.PseudoStatSchoolHitPercentFire,
	16: PseudoStat.PseudoStatSchoolHitPercentFrost,
	2: PseudoStat.PseudoStatSchoolHitPercentHoly,
	8: PseudoStat.PseudoStatSchoolHitPercentNature,
	32: PseudoStat.PseudoStatSchoolHitPercentShadow,
};
/** `SpellSchoolPhysical`, which uses melee hit, not spell hit. */
const SPELL_SCHOOL_PHYSICAL = 1;

const MELEE_HIT_BUDGET: RepairPolicy = {
	kind: 'budget',
	hitPercentPseudoStat: PseudoStat.PseudoStatMeleeHitPercent,
};
const SPELL_HIT_BUDGET: RepairPolicy = {
	kind: 'budget',
	hitPercentPseudoStat: PseudoStat.PseudoStatSpellHitPercent,
};
/**
 * The two `SpellMod_BonusHit_Percent` talents in `sim/mage`, `sim/priest` and
 * `sim/warlock`. Positions follow `ui/sim/talents/trees/<class>.json`.
 */
const SHADOW_SPELL_HIT_BUDGET: RepairPolicy = {
	...SPELL_HIT_BUDGET,
	// Smite and Mind Blast only (`sim/priest/talents.go`).
	perSpellHitTalents: [{ treeSegment: 0, talentIndex: 15, talent: 'Focused Power' }],
};
const WARLOCK_SPELL_HIT_BUDGET: RepairPolicy = {
	...SPELL_HIT_BUDGET,
	// Affliction spells only (`sim/warlock/talents.go`).
	perSpellHitTalents: [{ treeSegment: 0, talentIndex: 0, talent: 'Suppression' }],
};
const FULL_WEIGHT: RepairPolicy = { kind: 'fullWeight' };

/**
 * Improved Faerie Fire's hit, which `computeStats` does not return: it is a
 * target-side `ReducedPhysicalHitTakenChance` (`sim/core/debuffs.go`).
 */
export const IMPROVED_FAERIE_FIRE_HIT_PERCENT = 3;

/**
 * The target level the 9% physical cap holds against: 8% miss plus 1% hit
 * suppression at level 73 (`sim/core/target.go`).
 */
export const RAID_BOSS_LEVEL = 73;

/**
 * Rating per hit percent, the same values as ui/sim/constants/mechanics.ts and
 * sim/core/base_stats_auto_gen.go.
 */
export const PHYSICAL_HIT_RATING_PER_HIT_PERCENT = 15.769233;
export const SPELL_HIT_RATING_PER_HIT_PERCENT = 12.615385;

/** A yellow attack misses a level-73 boss 9% of the time before hit rating. */
export const PHYSICAL_HIT_CAP_PERCENT = 9;

/**
 * Spell hit cap against a level-73 boss. Base miss is 17% (`sim/core/target.go`),
 * but miss never drops below 1% (`sim/core/spell_result.go`), so the 17th
 * percent does nothing. Binary spells still gain from hit past the cap against
 * partial resists; that depends on the spell, and this table is per spec.
 */
export const SPELL_HIT_CAP_PERCENT = 16;

/** Every `SpecId` must have an entry; the file comment says why. */
export const CAP_PROFILE_BY_SPEC: Readonly<Record<SpecId, CapProfile>> = {
	ret: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: true,
		repair: MELEE_HIT_BUDGET,
	},
	feral: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: true,
		repair: MELEE_HIT_BUDGET,
	},

	balance: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: FULL_WEIGHT,
	},

	/**
	 * Hunters use melee hit rating: the sim has no ranged hit rating
	 * (`sim/core/unit.go`), and ranged attacks add `RangedHitPercent`, a percent
	 * with no rating behind it, to `PhysicalHitPercent`
	 * (`sim/core/spell_result.go`). No expertise: nothing a hunter fires can be
	 * dodged or parried.
	 */
	hunter: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: FULL_WEIGHT,
	},

	mage: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: SPELL_HIT_BUDGET,
	},

	shadow: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: SHADOW_SPELL_HIT_BUDGET,
	},

	rogue: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: true,
		repair: FULL_WEIGHT,
	},

	ele: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: FULL_WEIGHT,
	},

	enh: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: true,
		repair: FULL_WEIGHT,
	},

	warlock: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: false,
		repair: WARLOCK_SPELL_HIT_BUDGET,
	},

	warrior: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		hasExpertiseCap: true,
		repair: FULL_WEIGHT,
	},
};

/**
 * The profile a caller with no spec gets: ret's, so it reads the melee cap
 * rather than a made-up neutral profile.
 */
export const DEFAULT_CAP_PROFILE: CapProfile = CAP_PROFILE_BY_SPEC.ret;

/**
 * A typed `SpecId` always hits a row. The `?? DEFAULT_CAP_PROFILE` covers
 * untyped values that reach here through a cast, because gem fill must degrade
 * rather than throw on a spec it does not recognise.
 */
export function capProfileFor(spec: SpecId | undefined): CapProfile {
	if (spec === undefined) return DEFAULT_CAP_PROFILE;
	return CAP_PROFILE_BY_SPEC[spec] ?? DEFAULT_CAP_PROFILE;
}

/**
 * The hit rating meta repair may still value for a character the sim has read:
 * `(cap − Improved Faerie Fire − sim hit %) × rating per %`. `pseudoStats` is
 * the first player's `finalStats.pseudoStats` from `computeStats`, which holds
 * hit from every player-side source. Improved Faerie Fire is on the target and
 * affects physical hit only (`sim/core/debuffs.go`), so only melee-hit specs
 * subtract it. Undefined for a `fullWeight` spec, when a target is not level 73,
 * or when the hit percent is not a finite number.
 *
 * For spell hit, `groups` come from `spellDamageBySchool`: a spell's hit is
 * `PseudoStatSpellHitPercent` plus its school's `PseudoStatSchoolHitPercent*` bonus
 * (`sim/core/character_sheet.go`), a spell with two schools gets no school
 * bonus (`sim/core/flags.go`), and physical damage is left out. It throws when
 * spell damage by school is missing, so no caster is valued without it.
 */
export function hitCapBudgetFrom(
	profile: CapProfile,
	request: unknown,
	pseudoStats: readonly number[],
	spellDamageBySchool?: SpellDamageBySchool,
): HitCapBudget | undefined {
	const { repair } = profile;
	if (repair.kind !== 'budget') return undefined;
	if (!targetsAtCapLevel(request)) return undefined;
	const req = request as { raid?: { debuffs?: { faerieFire?: unknown } } };
	const hitPercent = pseudoStats[repair.hitPercentPseudoStat];
	if (typeof hitPercent !== 'number' || !Number.isFinite(hitPercent)) {
		return undefined;
	}
	const faerieFire = req.raid?.debuffs?.faerieFire;
	const improved = faerieFire === 'TristateEffectImproved' || faerieFire === 2;
	const faerieFireHitPercent = improved && profile.hitStat === Stat.StatMeleeHitRating ? IMPROVED_FAERIE_FIRE_HIT_PERCENT : 0;
	const remaining = (profile.hitCapPercent - faerieFireHitPercent - hitPercent) * profile.ratingPerPercent;
	if (!usesSpellHitBudget(profile)) {
		return { stat: profile.hitStat, remaining };
	}
	if (spellDamageBySchool === undefined) {
		throw new Error('the sim result has no spell damage by school, so spell hit cannot be priced');
	}
	return {
		stat: profile.hitStat,
		remaining,
		groups: spellHitGroups(pseudoStats, hitPercent, spellDamageBySchool, profile.ratingPerPercent),
	};
}

/**
 * Whether the request has targets and all are at the level the caps assume,
 * which `hitCapBudgetFrom` needs.
 */
export function targetsAtCapLevel(request: unknown): boolean {
	const targets = (request as { encounter?: { targets?: ReadonlyArray<{ level?: unknown }> } }).encounter?.targets ?? [];
	return targets.length > 0 && targets.every(t => t.level === RAID_BOSS_LEVEL);
}

/** `hitCapBudgetFrom` splits it by the spells a sim result shows cast. */
export function usesSpellHitBudget(profile: CapProfile): boolean {
	return profile.repair.kind === 'budget' && profile.repair.hitPercentPseudoStat === PseudoStat.PseudoStatSpellHitPercent;
}

function spellHitGroups(
	pseudoStats: readonly number[],
	sharedPercent: number,
	spellDamageBySchool: SpellDamageBySchool,
	ratingPerPercent: number,
): HitCapGroup[] {
	const damageByOffset = new Map<number, number>();
	let total = 0;
	for (const [key, damage] of Object.entries(spellDamageBySchool)) {
		const school = Number(key);
		if (!(damage > 0) || school === SPELL_SCHOOL_PHYSICAL) continue;
		const hitPercentIndex = SCHOOL_HIT_PSEUDO_STAT[school];
		const schoolPercent = hitPercentIndex === undefined ? sharedPercent : (pseudoStats[hitPercentIndex] ?? sharedPercent);
		const offset = Math.max(0, schoolPercent - sharedPercent) * ratingPerPercent;
		damageByOffset.set(offset, (damageByOffset.get(offset) ?? 0) + damage);
		total += damage;
	}
	return [...damageByOffset].sort(([a], [b]) => a - b).map(([offset, damage]) => ({ offset, share: damage / total }));
}

/**
 * The points in `entry`'s talent, read from a wowhead-format `talentsString`
 * (proto.Player.talents_string). 0 when there is no entry, no string, or no
 * digit at the entry's position.
 */
export function talentPoints(talentsString: string | undefined, entry: TalentPosition | undefined): number {
	if (!entry || talentsString === undefined) return 0;
	const segment = talentsString.split('-')[entry.treeSegment];
	const points = Number(segment?.charAt(entry.talentIndex) || 0);
	return Number.isFinite(points) && points > 0 ? points : 0;
}

/**
 * The first per-spell hit talent the player has points in. Neither
 * `computeStats` nor the action metrics show its hit, so `hitCapBudgetFrom`
 * leaves it out and the spells it covers reach the cap sooner than counted.
 */
export function perSpellHitTalentTaken(profile: CapProfile, talentsString: string | undefined): string | undefined {
	const { repair } = profile;
	if (repair.kind !== 'budget') return undefined;
	return (repair.perSpellHitTalents ?? []).find(position => talentPoints(talentsString, position) > 0)?.talent;
}
