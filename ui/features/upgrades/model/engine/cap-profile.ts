/**
 * Per-spec hit-cap numbers that gem fill (`gemFillWeights`) and meta repair
 * (`hitCapBudgetFrom`) use to value hit and expertise gems, so neither branches
 * on the spec.
 *
 * `CAP_PROFILE_BY_SPEC` is total over `SpecId` on purpose: a new spec without a
 * profile is a compile error rather than silently inheriting ret's melee cap.
 * The sim derives miss chance from level difference and hardcodes no cap, so
 * the cap percentages live here.
 */

import type { SpellDamageBySchool } from './seams/sim-runner';
import { Stat } from './stats';
import type { SpecId } from './types';

/**
 * Where a talent sits in a talent string: `treeSegment` indexes
 * `talentsString.split("-")`, `talentIndex` the characters in that segment.
 * Both follow the tree json order the talent-string encoder writes
 * (`ui/sim/talents/trees/<class>.json`), which can differ from the proto order,
 * so read that json before adding an entry.
 */
export type TalentPosition = {
	readonly treeSegment: number;
	readonly talentIndex: number;
	readonly talent: string;
};

/**
 * What gem fill and meta repair need to know about one spec's hit and expertise
 * caps. `hitStat` is a gear `Stat` for both schools (casters carry
 * `StatSpellHitRating`), not a pseudo-stat.
 */
export type CapProfile = {
	/** The rating stat the spec's gear uses for hit. */
	readonly hitStat: Stat;
	/** Percent of hit needed against a raid boss (level 73). */
	readonly hitCapPercent: number;
	/** Rating per one percent of hit, for this school. */
	readonly ratingPerPercent: number;
	/**
	 * Whether expertise is a cap this spec has, so gem fill zeroes its weight
	 * (`gemFillWeights`). False for casters, whose spells cannot be dodged or
	 * parried, and for hunters, whose ranged shots cannot be.
	 */
	readonly trackExpertise: boolean;
	/**
	 * How meta repair values hit gems. Required, so a new spec must choose: a
	 * `budget` charges hit gems against `hitCapPercent − (pseudo-stat hit %)`
	 * from `computeStats`; `fullWeight` counts hit at full value and the ranking
	 * says so in one note. A spec gets a budget only when one pseudo-stat never
	 * undervalues hit the sim still rewards for the default rotation's spells.
	 *
	 * Ret and feral budget on melee hit; mage, shadow and warlock on spell hit,
	 * by the schools the baseline sim cast (`HitCapBudget.groups`). Rogue,
	 * enhancement, warrior (Arms shares the spec id) and melee-weaving hunter
	 * presets dual-wield, which adds 19% white miss (`sim/core/spell_outcome.go`),
	 * and elemental's and balance's stats read holds hit from Totem of Wrath or
	 * Balance of Power that combat does not give every spell, so those get full
	 * weight. Known gaps: a feral's own Improved Faerie Fire is not in
	 * `raid.debuffs`, and item procs and explosives are priced at their school's
	 * slot although their hit differs.
	 */
	readonly repair: RepairPolicy;
};

/** See `CapProfile.repair`. */
export type RepairPolicy =
	| {
			readonly kind: 'budget';
			readonly hitPercentPseudoStat: number;
			/**
			 * Talents that add hit to some spells only, which neither the stats read
			 * nor the sim's action metrics show. See `perSpellHitTalentTaken`.
			 */
			readonly perSpellHitTalents?: readonly TalentPosition[];
	  }
	| { readonly kind: 'fullWeight' };

/**
 * The hit rating still useful against the cap, negative when the gear is over
 * it. `remaining` is for the hit every attack or spell shares, the budget's
 * pseudo-stat. A spell-hit budget also has `groups`: the spells the baseline sim
 * cast, grouped by how much more hit than that they get (`offset`, rating), each
 * with its share of their damage. Hit is worth a group's share until
 * `remaining − offset` is used up. Absent means one group with offset 0 and
 * share 1.
 */
export type HitCapBudget = {
	readonly stat: Stat;
	readonly remaining: number;
	readonly groups?: readonly HitCapGroup[];
};

/** See `HitCapBudget.groups`. */
export type HitCapGroup = { readonly offset: number; readonly share: number };

/** `PseudoStatMeleeHitPercent` in `ui/generated/proto/common.ts`. */
const PSEUDO_STAT_MELEE_HIT_PERCENT = 12;
/** `PseudoStatSpellHitPercent` in `ui/generated/proto/common.ts`. */
const PSEUDO_STAT_SPELL_HIT_PERCENT = 13;
/**
 * The school hit pseudo-stat (`PseudoStatSchoolHitPercentArcane` to
 * `...Shadow`, `ui/generated/proto/common.ts`) of each single magic
 * school, keyed by the sim's `SpellSchool` bit (`sim/core/flags.go`),
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
	kind: 'budget',
	hitPercentPseudoStat: PSEUDO_STAT_MELEE_HIT_PERCENT,
};
const SPELL_HIT_BUDGET: RepairPolicy = {
	kind: 'budget',
	hitPercentPseudoStat: PSEUDO_STAT_SPELL_HIT_PERCENT,
};
/**
 * The two `SpellMod_BonusHit_Percent` talents of the spell-budget classes
 * (`grep -rn SpellMod_BonusHit_Percent sim/mage sim/priest sim/warlock`).
 * Positions follow `ui/sim/talents/trees/<class>.json`.
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
 * Spell hit cap vs a level-73 boss: 17% base miss (`sim/core/target.go`), but
 * miss is floored at 1% (`sim/core/spell_result.go`), so the 17th percent buys
 * nothing. Binary spells still gain from hit past the cap against partial
 * resists; that is per spell, and this table is per spec.
 */
export const SPELL_HIT_CAP_PERCENT = 16;

/**
 * Per-spec cap descriptors. Total over `SpecId` by construction — see the file
 * comment on why that totality is the point.
 */
export const CAP_PROFILE_BY_SPEC: Readonly<Record<SpecId, CapProfile>> = {
	ret: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: true,
		repair: MELEE_HIT_BUDGET,
	},
	feral: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: true,
		repair: MELEE_HIT_BUDGET,
	},

	balance: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: FULL_WEIGHT,
	},

	/**
	 * Hunters read melee hit rating: the sim has no ranged hit rating
	 * (`sim/core/unit.go`), and ranged attacks add a percent-only
	 * `RangedHitPercent` on top of `PhysicalHitPercent`
	 * (`sim/core/spell_result.go`). No expertise: nothing a hunter fires can be
	 * dodged or parried.
	 */
	hunter: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: FULL_WEIGHT,
	},

	mage: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: SPELL_HIT_BUDGET,
	},

	shadow: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: SHADOW_SPELL_HIT_BUDGET,
	},

	rogue: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: true,
		repair: FULL_WEIGHT,
	},

	ele: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: FULL_WEIGHT,
	},

	enh: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: true,
		repair: FULL_WEIGHT,
	},

	warlock: {
		hitStat: Stat.StatSpellHitRating,
		hitCapPercent: SPELL_HIT_CAP_PERCENT,
		ratingPerPercent: SPELL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: false,
		repair: WARLOCK_SPELL_HIT_BUDGET,
	},

	warrior: {
		hitStat: Stat.StatMeleeHitRating,
		hitCapPercent: PHYSICAL_HIT_CAP_PERCENT,
		ratingPerPercent: PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
		trackExpertise: true,
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
 * The repair hit budget of a character the sim read:
 * `(cap − Improved Faerie Fire − sim hit %) × rating per %`. `pseudoStats` is
 * the first player's `finalStats.pseudoStats` from `computeStats`, whose hit
 * percent holds every player-side source. Improved Faerie Fire is target-side
 * and physical only (`sim/core/debuffs.go`), so it counts for melee-hit specs
 * only. Undefined when the repair is not a budget, a target is not at the cap
 * level, or the read is not finite.
 *
 * A spell-hit budget gets `groups` from `spellDamageBySchool`: a spell's hit is
 * slot 13 plus its school's slot 6-11 bonus (`sim/core/character_sheet.go`), a
 * two-school spell gets no school bonus (`sim/core/flags.go`), and physical
 * damage takes no share. It throws when a spell budget has no damage by school,
 * so no caster is priced without it.
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
	const fire = improved && profile.hitStat === Stat.StatMeleeHitRating ? IMPROVED_FAERIE_FIRE_HIT_PERCENT : 0;
	const remaining = (profile.hitCapPercent - fire - hitPercent) * profile.ratingPerPercent;
	if (!pricesHitBySpells(profile)) {
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
 * Whether the request has targets and every one is at the level the caps
 * hold for, which a budget needs.
 */
export function targetsAtCapLevel(request: unknown): boolean {
	const targets = (request as { encounter?: { targets?: ReadonlyArray<{ level?: unknown }> } }).encounter?.targets ?? [];
	return targets.length > 0 && targets.every(t => t.level === RAID_BOSS_LEVEL);
}

/**
 * Whether the spec's budget is on spell hit, which `hitCapBudgetFrom` prices
 * by the spells a sim result shows cast.
 */
export function pricesHitBySpells(profile: CapProfile): boolean {
	return profile.repair.kind === 'budget' && profile.repair.hitPercentPseudoStat === PSEUDO_STAT_SPELL_HIT_PERCENT;
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
		const slot = SCHOOL_HIT_PSEUDO_STAT[school];
		const schoolPercent = slot === undefined ? sharedPercent : (pseudoStats[slot] ?? sharedPercent);
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
 * The first per-spell hit talent the player has points in. The budget leaves its
 * hit out, since neither the stats read nor the sim's action metrics show it, so
 * the spells it covers reach the cap sooner than the budget counts.
 */
export function perSpellHitTalentTaken(profile: CapProfile, talentsString: string | undefined): string | undefined {
	const { repair } = profile;
	if (repair.kind !== 'budget') return undefined;
	return (repair.perSpellHitTalents ?? []).find(position => talentPoints(talentsString, position) > 0)?.talent;
}
