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
 * Narrow a detected spec to one the cap table knows.
 *
 * `feral-tank` is detectable but not rankable, so it has no cap profile. It
 * reaches gem code only via `SPEC_PREFERRED_METAS`, and dropping it here yields
 * the undefined-spec default — the melee profile, which is the right school for
 * a bear regardless.
 */
function rankableSpec(spec: DetectedSpecId | undefined): SpecId | undefined {
	return spec === undefined || spec === 'feral-tank' ? undefined : spec;
}

/**
 * Record-only weights. Narrower than `stats.ts`'s `EpWeights` union — this
 * module never receives the dense-array form, so keep the record type
 * explicit here rather than importing the wider union.
 */
type EpWeightRecord = Readonly<Record<string, number>>;

/**
 * The values every gem decision needs, passed together through the
 * candidate-swap chain.
 *
 * `weights` and `weightRecord` are the *same* weights in the two forms the
 * code below needs: `epScore` in `stats.ts` accepts the dense-array form, the
 * gem fillers only ever want the record. Deriving the record once at
 * construction means callers cannot pass two forms that disagree.
 */
export type GemContext = {
	readonly palette: readonly GemEntry[];
	/**
	 * The palette both auto-fill and meta repair may draw from: `palette`
	 * capped at rare. Repair only touches coloured sockets (never the meta
	 * socket), and on the full palette it would hand out epic gems the fill
	 * deliberately avoids. Every colour exists at rare and all 18 TBC meta gems
	 * are quality 3, so nothing becomes unsolvable under the cap.
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
	 * Meta repair's hit budget, set once the sim has read the
	 * baseline's hit: the rating still useful on the baseline, and the hit the
	 * baseline's equipment has by `gearHitRating`. Each swap's budget is
	 * `baselineRemaining − (gearHitRating(swapped) − baselineGearHit)`. Absent
	 * means repair values hit at full weight. `groups` are the baseline
	 * budget's (`HitCapBudget.groups`); every swap keeps them.
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
 * Stat EP cannot rank meta gems: their headline effects are not stats. Nine of
 * the eighteen TBC metas score exactly 0.00 against ret weights, and the two
 * that matter here invert — Swift Skyfire's flat +24 AP scores 9.84 while
 * Relentless scores 9.00 on +12 Agi alone, because its +3% critical damage is
 * a multiplier (`CritDamageMultiplier *= 1.03` in wowsims
 * `sim/core/item_effects.go`) and additive EP cannot see it.
 *
 * The effect enters average damage as `crit * (critDmgMult - 1)`
 * (`sim/core/spell_outcome.go`), so its absolute value scales with crit and is
 * **not** a constant — roughly 0.6% of damage at 10% crit up to 2.4% at 40%.
 * The *ordering* is what is durable: against Swift Skyfire's +24 AP,
 * Relentless leads by ~7x at 10% crit and ~28x at 40%, so it never flips in
 * any realistic ret range.
 *
 * Ret's meta is Relentless Earthstorm Diamond in every wowsims ret gear preset
 * (ui/specs/paladin/retribution/gear_sets/), which carry no other meta.
 *
 * Activation is deliberately not checked. Relentless requires 2 red / 2 yellow
 * / 2 blue elsewhere, and a player who slots a meta arranges their other gems
 * to switch it on. Gating on the colours they happen to wear today would
 * understate a genuine upgrade.
 */
const PREFERRED_META_IDS: readonly number[] = [32409];

/**
 * Preferred meta gem per detected spec, read from the meta socketed in that
 * spec's wowsims gear presets (ui/specs/<class>/<spec>/gear_sets/). It is not
 * an EP ranking, because stat EP cannot rank metas at all.
 *
 * Presets are read by gem colour rather than array position: `gems` follows
 * the head item's own socket order, so the meta is not always `gems[0]` (Cowl
 * of Gul'dan, id 34332, sockets `[4,1]`, holds its meta second). No spec
 * changes meta between phases. Some presets wear a socketless head: feral
 * cat's 15 lower sets wear Wolfshead Helm (8345) and only p5 seats 32409;
 * priest's pre-raid and p1 sets wear Spellstrike Hood (24266) and only p2/p3
 * seat 25893.
 *
 * A feral row matters even though most feral presets wear no meta: without
 * one, a Wolfshead baseline has no socket to be missing anything from and
 * prices at full value, while every meta-socket candidate head prices with an
 * empty socket against it.
 *
 * The `feral-tank` row is read from the bear presets
 * (ui/specs/druid/feralbear/gear_sets/). Seven of the eleven sets socket 32409,
 * three wear socketless Wolfshead, and p5 uses Powerful Earthstorm Diamond
 * 25896; the row follows the majority. `feral-tank` is identified but never
 * ranked (it is not a `SpecId`), so its row only keeps
 * `missingMetaPreferenceNote` and `metaSocketUnpriced` quiet for it.
 *
 * The type is total over `SpecId` and optional only for the
 * identify-but-not-rank remainder of `DetectedSpecId`, so a new rankable spec
 * cannot reach the empty-socket branch by omission. On adding one, read its
 * meta from its presets; do not inherit another spec's row.
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
 * `undefined` when there is nothing to disclose.
 *
 * Fail loud: silently leaving the socket empty looks identical to a palette
 * that had no meta gem, and silently seating ret's would be wrong. Naming the
 * spec is what lets a reader tell the two apart. The note names the lost
 * socket bonus too, because the sim pays no socket bonus while a socket is
 * empty.
 */
export function missingMetaPreferenceNote(spec: DetectedSpecId | undefined): string | undefined {
	if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return undefined;
	return `The ranking does not know which meta gem your spec uses, so new items with a meta socket got the meta gem you wear, or an empty socket and no socket bonus if you wear none.\nspec: ${spec}`;
}

/**
 * Whether this candidate's price omits a meta gem. The per-row half of the
 * disclosure above — the run-level note cannot tell a reader which rows it
 * moved.
 *
 * Reads `gems` — the array the candidate was actually priced with — rather
 * than deciding from socket colours and the spec table alone. `swapItemAt`
 * fills from `migrateGemsToItem`, which brings a worn meta onto the
 * candidate, so a spec with no recorded preference can still end up with a
 * full socket, and a colour-only test would report an empty meta socket over
 * a seated gem.
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
	 * Meta gem + gems on **other slots only**. Gems kept on the piece under fill
	 * are contributed by the fill itself — listing them here double-counts their
	 * colour and can zero the deficit before any candidate is scored.
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
 *
 * Deliberate simplification, not a mirror of wowsims' suggest-gems button:
 * the button re-gems existing body gems and skips meta sockets, whereas this
 * keeps every worn gem and fills only what migration left empty. Do not "fix"
 * this toward the button: silently re-gemming worn slots hides which gems the
 * ranking used.
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
 * Softcaps: hit / expertise EP overstates gems on capped raid sets.
 * Used only for candidate socket fills. Meta repair does not use these
 * weights: on the budget specs (`CAP_PROFILE_BY_SPEC`, cap-profile.ts) it
 * values hit up to a budget the sim reads (`GemContext.repairHitCap`),
 * elsewhere at full weight.
 *
 * Which stats are softcapped is the spec's own question, and getting it wrong
 * is silent in both directions: zeroing melee hit for a caster leaves spell hit
 * gems overvalued *and* discards nothing, while zeroing expertise for a hunter
 * suppresses a stat the spec was never going to gem anyway. The profile answers
 * both — `hitStat` names the one hit stat that softcaps, and `trackExpertise`
 * says whether expertise is a cap this spec has at all.
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
		// No recorded preference: leave the socket empty rather than fall through
		// to the EP pick below. EP cannot rank metas — nine of eighteen score
		// 0.00 — so "best by EP" would be an arbitrary gem wearing the authority
		// of a measurement, and inheriting another spec's meta would be worse.
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
