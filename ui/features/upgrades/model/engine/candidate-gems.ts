/**
 * Fills empty sockets on a candidate item with the highest-EP gems the phase
 * allows, up to rare quality (`GemContext.fillGems`).
 */
import { GemColor } from '@generated/proto/common';

import { capProfileFor, type HitCapGroup } from './cap-profile';
import { fillEligibleGems, type GemEntry, getGem } from './gems';
import { getItem, socketsFor } from './items';
import { gemColorCounts, gemColorMatchesSocket, metaDeficit, socketBonusActive } from './meta';
import { epScore, type EpWeights, Stat } from './stats';
import type { DetectedSpecId, SpecId } from './types';

/**
 * Narrow a detected spec to one `CAP_PROFILE_BY_SPEC` lists. `feral-tank` is
 * detected but never ranked, so it gets the default melee profile, which suits
 * a bear.
 */
function rankableSpec(spec: DetectedSpecId | undefined): SpecId | undefined {
	return spec === undefined || spec === 'feral-tank' ? undefined : spec;
}

/** Weights keyed by stat index; never the array form of `EpWeights`. */
type EpWeightRecord = Readonly<Record<string, number>>;

/**
 * The values every gem choice for a candidate swap needs. `weights` and
 * `weightRecord` are the same weights in two forms; `gemContext` builds the
 * record once so callers cannot pass two that disagree.
 */
export type GemContext = {
	readonly phaseGems: readonly GemEntry[];
	/**
	 * The gems socket filling and meta repair may use: `phaseGems` capped at rare,
	 * so meta repair adds no epic gems that filling would not. Every color exists
	 * at rare and every TBC meta gem is rare, so the cap removes no color or meta.
	 */
	readonly fillGems: readonly GemEntry[];
	readonly weights: EpWeights;
	readonly weightRecord: EpWeightRecord;
	/**
	 * Which spec's preferred meta applies. Absent means "unspecified", which
	 * uses ret's entry (`PREFERRED_META_IDS`).
	 */
	readonly spec?: DetectedSpecId;
	/**
	 * The hit meta repair may still value, set once the sim has read the
	 * baseline: the rating still useful there, and the hit rating on its gear
	 * (`gearHitRating`). For a swap it is
	 * `baselineRemaining − (gearHitRating(swapped) − baselineGearHit)`, with the
	 * baseline's `groups`. Absent means meta repair values hit at full weight.
	 */
	readonly repairHitBudget?: {
		readonly stat: Stat;
		readonly baselineRemaining: number;
		readonly baselineGearHit: number;
		readonly groups?: readonly HitCapGroup[];
	};
};

export function gemContext(phaseGems: readonly GemEntry[], weights: EpWeights, spec?: DetectedSpecId): GemContext {
	return {
		phaseGems,
		fillGems: fillEligibleGems(phaseGems),
		weights,
		weightRecord: toWeightRecord(weights),
		...(spec !== undefined ? { spec } : {}),
	};
}

function toWeightRecord(weights: EpWeights): EpWeightRecord {
	if (!Array.isArray(weights)) return weights as EpWeightRecord;
	const out: Record<string, number> = {};
	for (let i = 0; i < weights.length; i++) out[String(i)] = weights[i] ?? 0;
	return out;
}

/** EP margin within which the meta's color needs may pick a lower-EP gem. */
const META_NEAR_EP = 1.0;

const RELENTLESS_EARTHSTORM_DIAMOND = 32409;
const CHAOTIC_SKYFIRE_DIAMOND = 34220;
const MYSTICAL_SKYFIRE_DIAMOND = 25893;

/**
 * The meta in every wowsims ret gear preset
 * (ui/specs/paladin/retribution/gear_sets/). Stat EP cannot rank metas: nine of
 * the eighteen score 0 against ret weights, and Relentless's +3% crit damage is
 * a multiplier (`sim/core/item_effects.go`) that EP scores below Swift
 * Skyfire's +24 AP. Whether the meta is active is not checked: a player who
 * slots a meta arranges their other gems to turn it on.
 */
const PREFERRED_META_IDS: readonly number[] = [RELENTLESS_EARTHSTORM_DIAMOND];

/**
 * The meta gem each detected spec wears in its wowsims gear presets
 * (ui/specs/<class>/<spec>/gear_sets/), not ranked by EP. Find it in a preset by
 * gem color, not position: `gems` follows the head's socket order, so the meta
 * is not always `gems[0]`.
 *
 * Feral needs an entry although most feral presets wear the socketless
 * Wolfshead Helm: without one, every candidate head with a meta socket is simmed
 * with it empty, against current gear that lacks nothing. `feral-tank` (the
 * meta most bear presets wear) is never ranked; its entry only keeps
 * `missingMetaPreferenceNote` and `metaSocketUnpriced` quiet.
 *
 * The type requires every `SpecId`, so a new ranked spec cannot end up with an
 * empty meta socket by omission; take its meta from its own presets.
 */
export const SPEC_PREFERRED_METAS: Readonly<Record<SpecId, readonly number[]> & Partial<Record<DetectedSpecId, readonly number[]>>> = {
	ret: PREFERRED_META_IDS,
	feral: PREFERRED_META_IDS,
	'feral-tank': PREFERRED_META_IDS,

	// ui/specs/druid/balance/gear_sets/p5.gear.json, head 34403.
	balance: [CHAOTIC_SKYFIRE_DIAMOND],
	// ui/specs/mage/dps/gear_sets/p2Arcane.gear.json, head 30206.
	mage: [CHAOTIC_SKYFIRE_DIAMOND],
	// ui/specs/shaman/elemental/gear_sets/p5.gear.json, head 34332 (meta second).
	ele: [CHAOTIC_SKYFIRE_DIAMOND],
	// ui/specs/warlock/dps/gear_sets/swp.gear.json, head 34340.
	warlock: [CHAOTIC_SKYFIRE_DIAMOND],

	// Shadow is the one caster here not on Chaotic:
	// ui/specs/priest/dps/gear_sets/p3.gear.json, head 31064.
	shadow: [MYSTICAL_SKYFIRE_DIAMOND],

	// ui/specs/hunter/dps/gear_sets/phase_4/bm/2h_6p.gear.json, head 32235.
	hunter: PREFERRED_META_IDS,
	// ui/specs/rogue/dps/gear_sets/p3.gear.json, head 32235.
	rogue: PREFERRED_META_IDS,
	// ui/specs/shaman/enhancement/gear_sets/p5.gear.json, head 34333 (meta second).
	enh: PREFERRED_META_IDS,
	// ui/specs/warrior/dps/gear_sets/p5_fury.gear.json, head 34333 (meta second);
	// p5_arms.gear.json has the same one.
	warrior: PREFERRED_META_IDS,
};

/**
 * The note for a spec with no entry in `SPEC_PREFERRED_METAS`, or `undefined`.
 * It names the spec, because an empty socket alone looks like a gem list with no
 * meta gem, and the lost socket bonus, because the sim gives no socket bonus
 * while a socket is empty.
 */
export function missingMetaPreferenceNote(spec: DetectedSpecId | undefined): string | undefined {
	if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return undefined;
	return `The ranking does not know which meta gem your spec uses, so new items with a meta socket got the meta gem you wear, or an empty socket and no socket bonus if you wear none.\nspec: ${spec}`;
}

/**
 * Whether this candidate was simmed without a meta gem, so its row can say so;
 * the run-wide note above cannot say which rows it affects. It reads `gems`, the
 * gems the candidate was simmed with, because `migrateGemsToItem` can move a
 * worn meta onto the candidate even for a spec with no entry.
 */
export function metaSocketUnpriced(itemId: number, gems: readonly number[], spec: DetectedSpecId | undefined): boolean {
	if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return false;
	const metaIdx = socketsFor(itemId).indexOf(GemColor.GemColorMeta);
	if (metaIdx < 0) return false;
	return !gems[metaIdx];
}

export type FillEmptyOpts = {
	/** Unique gem ids already socketed elsewhere on the gear. */
	usedUnique?: ReadonlySet<number>;
	/**
	 * The meta gem and the gems on **other slots only**. The filler counts this
	 * piece's kept gems itself; listing them here counts their color twice and
	 * can make the meta's color needs look met before any gem is tried.
	 */
	meta?: { metaId: number; otherGemIds: readonly number[] };
	/**
	 * Whose preferred meta to seat. Absent uses ret's entry; a spec with no
	 * entry in `SPEC_PREFERRED_METAS` leaves the meta socket empty rather than
	 * inheriting another spec's gem.
	 */
	spec?: DetectedSpecId;
};

/**
 * Keeps the gems already placed and fills only empty sockets, by EP. Unlike
 * wowsims' Suggest Gems, it never replaces worn gems, which would hide which
 * gems the ranking used.
 */
export function fillEmptyCandidateGems(
	itemId: number,
	gems: readonly number[],
	allowedGems: readonly GemEntry[],
	epWeights: EpWeightRecord,
	opts: FillEmptyOpts = {},
): number[] {
	const sockets = socketsFor(itemId);
	if (sockets.length === 0) return [];

	const weights = gemFillWeights(epWeights, opts.spec);
	const base = sockets.map((_, i) => gems[i] ?? 0);
	const matched = fillEmpties(sockets, base, allowedGems, weights, true, opts);
	const free = fillEmpties(sockets, base, allowedGems, weights, false, opts);
	return layoutScore(itemId, sockets, free, weights) > layoutScore(itemId, sockets, matched, weights) ? free : matched;
}

/**
 * Weights for filling candidate sockets, with the spec's capped stats set to 0,
 * because hit and expertise EP overstate gems on raid gear that is already
 * capped. The cap profile names them: `hitStat`, and expertise when
 * `hasExpertiseCap`. Meta repair does not use these weights; it values hit with
 * `GemContext.repairHitBudget`, or at full weight.
 */
export function gemFillWeights(epWeights: EpWeightRecord, spec?: DetectedSpecId): Record<string, number> {
	const profile = capProfileFor(rankableSpec(spec));
	const out: Record<string, number> = { ...epWeights };
	out[String(profile.hitStat)] = 0;
	if (profile.hasExpertiseCap) out[String(Stat.StatExpertiseRating)] = 0;
	return out;
}

function fillEmpties(
	sockets: readonly number[],
	base: readonly number[],
	allowedGems: readonly GemEntry[],
	epWeights: EpWeightRecord,
	matchColors: boolean,
	opts: FillEmptyOpts,
): number[] {
	const out = [...base];
	const usedUnique = new Set(opts.usedUnique ?? []);
	for (const id of out) {
		const g = getGem(id);
		if (g?.unique) usedUnique.add(id);
	}

	for (let i = 0; i < sockets.length; i++) {
		if ((out[i] ?? 0) > 0) continue;
		const placed = out.filter(id => id > 0);
		const pick = bestGemForSocket(
			sockets[i]!,
			allowedGems,
			epWeights,
			usedUnique,
			matchColors,
			opts.meta
				? {
						metaId: opts.meta.metaId,
						gearGemIds: [...opts.meta.otherGemIds, ...placed],
					}
				: undefined,
			opts.spec,
		);
		if (pick) {
			out[i] = pick.id;
			if (pick.unique) usedUnique.add(pick.id);
		} else {
			out[i] = 0;
		}
	}

	return out;
}

function bestGemForSocket(
	socket: number,
	allowedGems: readonly GemEntry[],
	epWeights: EpWeightRecord,
	usedUnique: ReadonlySet<number>,
	matchColors: boolean,
	metaCtx: { metaId: number; gearGemIds: readonly number[] } | undefined,
	spec: DetectedSpecId | undefined,
): GemEntry | undefined {
	const eligible: { gem: GemEntry; ep: number }[] = [];

	for (const gem of allowedGems) {
		if (gem.unique && usedUnique.has(gem.id)) continue;

		if (socket === GemColor.GemColorMeta) {
			if (gem.color !== GemColor.GemColorMeta) continue;
		} else if (gem.color === GemColor.GemColorMeta) {
			continue;
		} else if (matchColors && !gemColorMatchesSocket(gem.color, socket)) {
			continue;
		}

		eligible.push({ gem, ep: epScore(gem.stats, epWeights) });
	}

	if (eligible.length === 0) return undefined;

	if (socket === GemColor.GemColorMeta) {
		const preferredIds = spec === undefined ? PREFERRED_META_IDS : SPEC_PREFERRED_METAS[spec];
		// No recorded preference: leave the socket empty. EP cannot rank metas, so
		// the EP pick below would seat an arbitrary gem.
		if (!preferredIds) return undefined;
		for (const preferred of preferredIds) {
			const hit = eligible.find(e => e.gem.id === preferred);
			if (hit) return hit.gem;
		}
	}

	let bestEp = -Infinity;
	for (const e of eligible) {
		if (e.ep > bestEp) bestEp = e.ep;
	}

	const near = eligible.filter(e => bestEp - e.ep <= META_NEAR_EP);
	const pool = near.length > 0 ? near : eligible;

	if (!metaCtx) {
		return pool.reduce((a, b) => (b.ep > a.ep ? b : a)).gem;
	}

	let best: { gem: GemEntry; ep: number; deficit: number } | undefined;
	for (const e of pool) {
		const afterDeficit = metaDeficit(metaCtx.metaId, gemColorCounts([...metaCtx.gearGemIds, e.gem.id]));
		if (!best || afterDeficit < best.deficit || (afterDeficit === best.deficit && e.ep > best.ep)) {
			best = { gem: e.gem, ep: e.ep, deficit: afterDeficit };
		}
	}

	return best?.gem;
}

function layoutScore(itemId: number, sockets: readonly number[], gemIds: readonly number[], epWeights: EpWeightRecord): number {
	let score = 0;
	for (const id of gemIds) {
		const gem = getGem(id);
		if (gem) score += epScore(gem.stats, epWeights);
	}

	if (socketBonusActive(sockets, gemIds)) {
		const bonus = getItem(itemId)?.socketBonus;
		if (bonus) score += epScore(bonus, epWeights);
	}

	return score;
}

/** Test helper. */
export function gemEp(gemId: number, epWeights: EpWeightRecord): number {
	const gem = getGem(gemId);
	return gem ? epScore(gem.stats, epWeights) : 0;
}
