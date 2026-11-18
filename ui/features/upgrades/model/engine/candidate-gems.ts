/**
 * Fill empty sockets on a candidate item with highest-EP gems from the phase
 * palette.
 */
import { GemColor } from '@generated/proto/common';

import { capProfileFor, type HitCapGroup } from './cap-profile';
import { fillEligibleGems, type GemEntry, getGem } from './gems';
import { getItem, socketsFor } from './items';
import { gemColorCounts, gemColorMatchesSocket, metaDeficit, socketBonusActive } from './meta';
import { epScore, type EpWeights, Stat } from './stats';
import type { DetectedSpecId, SpecId } from './types';

/**
 * Narrow a detected spec to one the cap table knows. `feral-tank` is detectable
 * but not rankable, so it has no cap profile and gets the default melee
 * profile, the right school for a bear.
 */
function rankableSpec(spec: DetectedSpecId | undefined): SpecId | undefined {
	return spec === undefined || spec === 'feral-tank' ? undefined : spec;
}

/** Record-only weights: the gem fillers never take `EpWeights`' dense-array form. */
type EpWeightRecord = Readonly<Record<string, number>>;

/**
 * The values every gem decision needs, passed together through the
 * candidate-swap chain. `weights` and `weightRecord` are the same weights in two
 * forms, the record derived once in `gemContext` so callers cannot pass two that
 * disagree.
 */
export type GemContext = {
	readonly palette: readonly GemEntry[];
	/**
	 * The palette both auto-fill and meta repair draw from: `palette` capped at
	 * rare, so repair hands out no epic gems the fill avoids. Every colour exists
	 * at rare and every TBC meta gem is quality 3, so nothing becomes unsolvable.
	 */
	readonly fillPalette: readonly GemEntry[];
	readonly weights: EpWeights;
	readonly weightRecord: EpWeightRecord;
	/**
	 * Which spec's preferred meta applies. Absent means "unspecified", which
	 * uses ret's entry (`PREFERRED_META_IDS`).
	 */
	readonly spec?: DetectedSpecId;
	/**
	 * Meta repair's hit budget, set once the sim has read the baseline's hit: the
	 * rating still useful on the baseline, and the baseline equipment's hit by
	 * `gearHitRating`. Each swap's budget is
	 * `baselineRemaining − (gearHitRating(swapped) − baselineGearHit)`, with the
	 * baseline's `groups`. Absent means repair values hit at full weight.
	 */
	readonly repairHitCap?: {
		readonly stat: Stat;
		readonly baselineRemaining: number;
		readonly baselineGearHit: number;
		readonly groups?: readonly HitCapGroup[];
	};
};

export function gemContext(palette: readonly GemEntry[], weights: EpWeights, spec?: DetectedSpecId): GemContext {
	return {
		palette,
		fillPalette: fillEligibleGems(palette),
		weights,
		weightRecord: toWeightRecord(weights),
		...(spec !== undefined ? { spec } : {}),
	};
}

/** Dense-array weights are index-keyed; the record form keys by the same index. */
function toWeightRecord(weights: EpWeights): EpWeightRecord {
	if (!Array.isArray(weights)) return weights as EpWeightRecord;
	const out: Record<string, number> = {};
	for (let i = 0; i < weights.length; i++) out[String(i)] = weights[i] ?? 0;
	return out;
}

/** Absolute EP slack for meta-aware near-ties (fill weights). */
const META_NEAR_EP = 1.0;

/**
 * Relentless Earthstorm Diamond, the meta in every wowsims ret gear preset
 * (ui/specs/paladin/retribution/gear_sets/). Stat EP cannot rank metas: nine of
 * the eighteen score 0 against ret weights, and Relentless's +3% crit damage is
 * a multiplier (`sim/core/item_effects.go`) that additive EP scores below Swift
 * Skyfire's +24 AP. Activation is not checked: a player who slots a meta
 * arranges their other gems to switch it on.
 */
const PREFERRED_META_IDS: readonly number[] = [32409];

/**
 * Preferred meta gem per detected spec, read from the meta socketed in that
 * spec's wowsims gear presets (ui/specs/<class>/<spec>/gear_sets/), not ranked
 * by EP. Read presets by gem colour, not position: `gems` follows the head's own
 * socket order, so the meta is not always `gems[0]`.
 *
 * Feral needs a row although most feral presets wear the socketless Wolfshead
 * Helm: without one, every meta-socket candidate head prices with an empty
 * socket against a baseline that is missing nothing. `feral-tank` (the bear
 * presets' majority meta) is never ranked; its row only keeps
 * `missingMetaPreferenceNote` and `metaSocketUnpriced` quiet for it.
 *
 * The type is total over `SpecId`, so a new rankable spec cannot reach the
 * empty-socket branch by omission; read its meta from its own presets.
 */
export const SPEC_PREFERRED_METAS: Readonly<Record<SpecId, readonly number[]> & Partial<Record<DetectedSpecId, readonly number[]>>> = {
	ret: PREFERRED_META_IDS,
	feral: PREFERRED_META_IDS,
	'feral-tank': PREFERRED_META_IDS,

	// Chaotic Skyfire Diamond — the caster crit meta.
	// ui/specs/druid/balance/gear_sets/p5.gear.json, head 34403.
	balance: [34220],
	// ui/specs/mage/dps/gear_sets/p2Arcane.gear.json, head 30206.
	mage: [34220],
	// ui/specs/shaman/elemental/gear_sets/p5.gear.json, head 34332 (meta second).
	ele: [34220],
	// ui/specs/warlock/dps/gear_sets/swp.gear.json, head 34340.
	warlock: [34220],

	// Mystical Skyfire Diamond. Shadow is the one caster here not on 34220:
	// ui/specs/priest/dps/gear_sets/p3.gear.json, head 31064, seats 25893.
	shadow: [25893],

	// Relentless Earthstorm Diamond — the same melee meta ret and feral use.
	// ui/specs/hunter/dps/gear_sets/phase_4/bm/2h_6p.gear.json, head 32235.
	hunter: PREFERRED_META_IDS,
	// ui/specs/rogue/dps/gear_sets/p3.gear.json, head 32235.
	rogue: PREFERRED_META_IDS,
	// ui/specs/shaman/enhancement/gear_sets/p5.gear.json, head 34333 (meta second).
	enh: PREFERRED_META_IDS,
	// ui/specs/warrior/dps/gear_sets/p5_fury.gear.json, head 34333 (meta second);
	// p5_arms.gear.json seats the same one.
	warrior: PREFERRED_META_IDS,
};

/**
 * The disclosure for a spec whose meta preference is not recorded, or
 * `undefined` when there is nothing to disclose. It names the spec, since a
 * silently empty socket looks like a palette with no meta gem, and the lost
 * socket bonus, since the sim pays none while a socket is empty.
 */
export function missingMetaPreferenceNote(spec: DetectedSpecId | undefined): string | undefined {
	if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return undefined;
	return `The ranking does not know which meta gem your spec uses, so new items with a meta socket got the meta gem you wear, or an empty socket and no socket bonus if you wear none.\nspec: ${spec}`;
}

/**
 * Whether this candidate's price omits a meta gem: the per-row half of the
 * disclosure above. It reads `gems`, the array the candidate was priced with,
 * because `migrateGemsToItem` can bring a worn meta onto the candidate, so a
 * spec with no recorded preference can still have a full meta socket.
 */
export function metaSocketUnpriced(itemId: number, gems: readonly number[], spec: DetectedSpecId | undefined): boolean {
	if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return false;
	const metaIdx = socketsFor(itemId).indexOf(GemColor.GemColorMeta);
	if (metaIdx < 0) return false;
	return !gems[metaIdx];
}

export type FillEmptyOpts = {
	/** Unique gem ids already socketed elsewhere on the set. */
	usedUnique?: ReadonlySet<number>;
	/**
	 * Meta gem + gems on **other slots only**. The fill adds the piece's own kept
	 * gems; listing them here double-counts their colour and can zero the
	 * deficit before any candidate is scored.
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
 * Keep already-placed gems; EP-fill only empty sockets (after UI-style migrate).
 * Unlike wowsims' suggest-gems button, this never re-gems worn sockets, which
 * would hide which gems the ranking used.
 */
export function fillEmptyCandidateGems(
	itemId: number,
	gems: readonly number[],
	palette: readonly GemEntry[],
	epWeights: EpWeightRecord,
	opts: FillEmptyOpts = {},
): number[] {
	const sockets = socketsFor(itemId);
	if (sockets.length === 0) return [];

	const weights = gemFillWeights(epWeights, opts.spec);
	const base = sockets.map((_, i) => gems[i] ?? 0);
	const matched = fillEmpties(sockets, base, palette, weights, true, opts);
	const free = fillEmpties(sockets, base, palette, weights, false, opts);
	return layoutScore(itemId, sockets, free, weights) > layoutScore(itemId, sockets, matched, weights) ? free : matched;
}

/**
 * Candidate socket fill weights with the spec's softcapped stats zeroed, since
 * hit and expertise EP overstate gems on capped raid sets. The cap profile names
 * them: `hitStat`, and expertise when `trackExpertise`. Meta repair does not use
 * these weights; it values hit by `GemContext.repairHitCap` or at full weight.
 */
export function gemFillWeights(epWeights: EpWeightRecord, spec?: DetectedSpecId): Record<string, number> {
	const profile = capProfileFor(rankableSpec(spec));
	const out: Record<string, number> = { ...epWeights };
	out[String(profile.hitStat)] = 0;
	if (profile.trackExpertise) out[String(Stat.StatExpertiseRating)] = 0;
	return out;
}

function fillEmpties(
	sockets: readonly number[],
	base: readonly number[],
	palette: readonly GemEntry[],
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
			palette,
			epWeights,
			usedUnique,
			matchColors,
			opts.meta
				? {
						metaId: opts.meta.metaId,
						setGemIds: [...opts.meta.otherGemIds, ...placed],
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
	palette: readonly GemEntry[],
	epWeights: EpWeightRecord,
	usedUnique: ReadonlySet<number>,
	matchColors: boolean,
	metaCtx: { metaId: number; setGemIds: readonly number[] } | undefined,
	spec: DetectedSpecId | undefined,
): GemEntry | undefined {
	const eligible: { gem: GemEntry; ep: number }[] = [];

	for (const gem of palette) {
		if (gem.unique && usedUnique.has(gem.id)) continue;

		if (socket === GemColor.GemColorMeta) {
			if (gem.colour !== GemColor.GemColorMeta) continue;
		} else if (gem.colour === GemColor.GemColorMeta) {
			continue;
		} else if (matchColors && !gemColorMatchesSocket(gem.colour, socket)) {
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
		const afterDeficit = metaDeficit(metaCtx.metaId, gemColorCounts([...metaCtx.setGemIds, e.gem.id]));
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

/** Test helper — resolve palette gem by id after fill. */
export function gemEp(gemId: number, epWeights: EpWeightRecord): number {
	const gem = getGem(gemId);
	return gem ? epScore(gem.stats, epWeights) : 0;
}
