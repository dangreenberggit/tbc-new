/**
 * Fill empty sockets on a candidate item with highest-EP gems from the phase
 * palette.
 *
 * PORTED from packages/core/src/candidate-gems.ts, unchanged except for
 * import paths retargeted at this directory's Database-backed items.ts/
 * gems.ts/meta.ts adapters.
 */
import { GemColor } from "../../../../proto/common.js";
import { capProfileFor } from "./cap-profile.js";
import { fillEligibleGems, type GemEntry,getGem } from "./gems.js";
import { getItem, socketsFor } from "./items.js";
import {
  gemColorCounts,
  gemColorMatchesSocket,
  metaDeficit,
  socketBonusActive,
} from "./meta.js";
import { epScore, type EpWeights,Stat } from "./stats.js";
import type { DetectedSpecId, SpecId } from "./types.js";

/**
 * Narrow a detected spec to one the cap table knows.
 *
 * `feral-tank` is detectable but not rankable, so it has no cap profile. It
 * reaches gem code only via `SPEC_PREFERRED_METAS`, and dropping it here yields
 * the undefined-spec default — the melee profile, which is the right school for
 * a bear regardless.
 */
function rankableSpec(spec: DetectedSpecId | undefined): SpecId | undefined {
  return spec === undefined || spec === "feral-tank" ? undefined : spec;
}

/**
 * Record-only weights. Narrower than `stats.ts`'s `EpWeights` union — this
 * module never receives the dense-array form, so keep the record type
 * explicit here rather than importing the wider union.
 */
type EpWeightRecord = Readonly<Record<string, number>>;

/**
 * The three values every gem decision needs, which previously travelled as
 * separate parameters through the whole candidate-swap chain (ticket 24's
 * data clump).
 *
 * `weights` and `weightRecord` are the *same* weights in the two forms the
 * code below needs: `epScore` in `stats.ts` accepts the dense-array form, the
 * gem fillers only ever want the record. Deriving the record once at
 * construction is why this is a context object and not just a tuple — callers
 * previously had to remember to pass both, in the right order, and nothing
 * stopped them passing weights that disagreed.
 */
export type GemContext = {
  readonly palette: readonly GemEntry[];
  /**
   * The palette both auto-fill and meta repair may draw from — `palette`
   * capped at rare. Ticket 111 left repair on the full `palette`, but repair
   * only ever touches coloured sockets (never the meta socket), and on those
   * it was quietly handing out epic gems the fill had deliberately avoided
   * (ticket 117). Every colour exists at rare and all 18 TBC meta gems are
   * quality 3, so nothing becomes unsolvable under the cap.
   */
  readonly fillPalette: readonly GemEntry[];
  readonly weights: EpWeights;
  readonly weightRecord: EpWeightRecord;
  /**
   * Which spec's preferred meta applies. Absent means "unspecified", which
   * keeps the pre-table behaviour — ret's entry — so every existing caller
   * reads exactly as it did before `SPEC_PREFERRED_METAS` existed.
   */
  readonly spec?: DetectedSpecId;
};

export function gemContext(
  palette: readonly GemEntry[],
  weights: EpWeights,
  spec?: DetectedSpecId
): GemContext {
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
 * Ret's meta is Relentless Earthstorm Diamond in all three upstream wowsims
 * ret gear presets (preraid, p1, p2 under
 * `ui/paladin/retribution/gear_sets/`), which carry no other meta.
 *
 * Activation is deliberately not checked. Relentless requires 2 red / 2 yellow
 * / 2 blue elsewhere, and a player who slots a meta arranges their other gems
 * to switch it on. Gating on the colours they happen to wear today would
 * understate a genuine upgrade.
 */
const PREFERRED_META_IDS: readonly number[] = [32409];

/**
 * Preferred meta gem per detected spec.
 *
 * The ret row is read from upstream's gear presets, per the evidence
 * procedure the ret comment above describes, extended per spec
 * (step6-meta-choice-spike.md option 1): read the meta socketed in that
 * spec's presets, as of `wowsims/tbc-new` @ v0.0.101 (`8aa378b3`). It is not
 * an EP ranking, because stat EP cannot rank metas at all — the ordering it
 * produces is the wrong one.
 *
 * **The `feral` row is an owner ruling — 2026-08-22, ticket 257.** It is the
 * one row here not read from a preset. All five vendored feral (cat) presets
 * (`preraid`, `p2_6p`, `p2_9p`, `p3_6p`, `p3_9p`) wear socketless Wolfshead
 * Helm 8345, so upstream socketed no cat meta to copy. Ticket 257 found that
 * leaving the row out was not the neutral "disclose and skip" it looked like:
 * for a feral who wears no meta (every Wolfshead wearer — the upstream-normal
 * case), the worn head has no socket to be missing anything from, so the
 * baseline prices at full value while every meta-socket candidate head prices
 * with an empty socket against it. A real under-pricing, not a symmetric gap.
 * The owner's ruling closes that gap rather than opening a general policy for
 * inventing metas: *"if theyre based on wowsims code, leave it i guess... but
 * if it is just for feral dps then you can just assume relentless earthstorm
 * would be the chosen meta gem, ezpz, done."* 32409 is not invented for the
 * occasion — every other row here reads it out of a wowsims preset.
 *
 * **The `feral-tank` row is read from upstream, like ret's.** It is sourced
 * from wowsims' bear presets, which are a separate spec upstream
 * (`SpecFeralBearDruid`, `ui/druid/feralbear/gear_sets/` in the fork clone)
 * and were missed when this table was first written — hence the earlier claim
 * here that upstream recorded no feral meta at all, which was wrong for bear.
 * Seven of the eleven bear sets socket 32409 (`p1`, `p2_balanced`,
 * `p2_offensive`, `p2_survival`, `p3`, `p4`, `preraid`); of the rest, three
 * wear socketless Wolfshead and `p5` uses Powerful Earthstorm Diamond 25896.
 * That last one is a genuine disagreement, not a scoping artefact: 25896 is
 * phase 1 in `data/gems/palette.json`, so it is in range for every phase this
 * project supports. The row follows the majority of the sets that socket a
 * meta at all, and this is the judgment call — 7 of 11 — that a derived table
 * would have to make explicit (ticket 263). Re-check with:
 *
 *     node -e "for (const f of require('fs').readdirSync('vendor/tbc-new-fork/ui/druid/feralbear/gear_sets')) { const g = require('./vendor/tbc-new-fork/ui/druid/feralbear/gear_sets/' + f); console.log(f, (g.items || []).flatMap(i => i.gems || []).filter(x => x === 32409).length); }"
 *
 * Note what the `feral-tank` row does and does not reach today. It is read —
 * `missingMetaPreferenceNote` and `metaSocketUnpriced` below both consult the
 * table for any spec, and its presence is what keeps them quiet for
 * feral-tank. What it never reaches is a ranking: `feral-tank` is identified
 * but never ranked (it is not a member of `SpecId`, `types.ts`), so no candidate
 * is ever gemmed from it. It is recorded because the evidence exists, not
 * because a ranking needs it.
 *
 * Only `DetectedSpecId`s can appear: a spec the pipeline cannot detect cannot
 * reach this code, so a row for one would be untestable decoration.
 *
 * **When the detectable-spec list grows, this table must grow with it**
 * (ticket 142, review row 5-D4). A newly detectable spec — a caster one
 * especially — falls into the "no preference recorded" branch by default, and
 * unlike feral's now-settled case that outcome is a quiet quality regression
 * (an empty meta socket where a real preference exists upstream) rather than
 * a fact about the game. So on adding a `DetectedSpecId`: find that spec's
 * meta in the vendored presets and add a row, or, if upstream genuinely
 * records none, get an owner ruling the way ticket 257 got one for feral — do
 * not leave it to the fallback and do not inherit another spec's row without
 * that ruling.
 *
 * The type below enforces exactly that rule for the *rankable* specs: it is
 * total over `SpecId` and optional only for the identify-but-not-rank
 * remainder of `DetectedSpecId`. A new rankable spec cannot reach the
 * empty-socket branch by omission any more — the compiler asks first.
 *
 * The nine rows added for the all-DPS-specs pass were each read out of that
 * spec's **highest-phase** vendored gear set, by gem colour rather than array
 * position: the meta is not reliably `gems[0]`, since the array follows the
 * head item's own socket order (Cowl of Gul'dan, id 34332, sockets `[4,1]`,
 * holds its meta second). Every one of the nine is stable across every phase
 * of that spec that seats a meta at all — no spec changes meta between phases.
 * Two carry a wrinkle worth knowing rather than a disagreement: priest's
 * pre-raid and p1 sets wear the socketless Spellstrike Hood (24266), and only
 * p2/p3 seat 25893; feral's 15 lower sets wear socketless Wolfshead (8345) and
 * only p5 seats 32409.
 */
export const SPEC_PREFERRED_METAS: Readonly<
  Record<SpecId, readonly number[]> &
    Partial<Record<DetectedSpecId, readonly number[]>>
> = {
  ret: PREFERRED_META_IDS,
  feral: PREFERRED_META_IDS,
  "feral-tank": PREFERRED_META_IDS,

  // Chaotic Skyfire Diamond — the caster crit meta.
  // ui/druid/balance/gear_sets/p5.gear.json, head 34403.
  balance: [34220],
  // ui/mage/dps/gear_sets/p2Arcane.gear.json, head 30206.
  mage: [34220],
  // ui/shaman/elemental/gear_sets/p5.gear.json, head 34332 (meta second).
  ele: [34220],
  // ui/warlock/dps/gear_sets/swp.gear.json, head 34340.
  warlock: [34220],

  // Mystical Skyfire Diamond. Shadow is the one caster here not on 34220:
  // ui/priest/dps/gear_sets/p3.gear.json, head 31064, seats 25893.
  shadow: [25893],

  // Relentless Earthstorm Diamond — the same melee meta ret and feral use.
  // ui/hunter/dps/gear_sets/phase_4/bm/2h_6p.gear.json, head 32235.
  hunter: PREFERRED_META_IDS,
  // ui/rogue/dps/gear_sets/p3.gear.json, head 32235.
  rogue: PREFERRED_META_IDS,
  // ui/shaman/enhancement/gear_sets/p5.gear.json, head 34333 (meta second).
  enh: PREFERRED_META_IDS,
  // ui/warrior/dps/gear_sets/p5_fury.gear.json, head 34333 (meta second);
  // p5_arms.gear.json seats the same one.
  warrior: PREFERRED_META_IDS,
};

/**
 * The disclosure for a spec whose meta preference is not recorded, or
 * `undefined` when there is nothing to disclose.
 *
 * Fail loud, per the spike: silently leaving the socket empty looks identical
 * to a palette that had no meta gem, and silently seating ret's would be
 * wrong. Naming the spec is what lets a reader tell the two apart.
 */
export function missingMetaPreferenceNote(
  spec: DetectedSpecId | undefined
): string | undefined {
  if (spec === undefined || SPEC_PREFERRED_METAS[spec]) return undefined;
  return `no meta preference recorded for ${spec} — meta sockets on candidate items were left empty, so those items are priced without any meta gem's stats or effect`;
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
 * full socket. Ticket 139: the colour-only test printed "priced with an empty
 * meta socket" over a seated gem, which is the failure this flag exists to
 * prevent.
 */
export function metaSocketUnpriced(
  itemId: number,
  gems: readonly number[],
  spec: DetectedSpecId | undefined
): boolean {
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
   * Whose preferred meta to seat. Absent keeps the pre-table behaviour (ret's
   * entry); a spec with no entry in `SPEC_PREFERRED_METAS` leaves the meta
   * socket empty rather than inheriting another spec's gem.
   */
  spec?: DetectedSpecId;
};

/**
 * Keep already-placed gems; EP-fill only empty sockets (after UI-style migrate).
 *
 * Deliberate simplification, not a mirror of wowsims' suggest-gems button
 * (ticket 111 "Two behavioural facts", observed in the owner's web session):
 * the button re-gems existing body gems and skips meta sockets, whereas we
 * keep every worn gem and fill only what migration left empty. Do not "fix"
 * this toward the button — silently re-gemming worn slots breaks the owner's
 * consistency principle (the user must know which gems were used).
 */
export function fillEmptyCandidateGems(
  itemId: number,
  gems: readonly number[],
  palette: readonly GemEntry[],
  epWeights: EpWeightRecord,
  opts: FillEmptyOpts = {}
): number[] {
  const sockets = socketsFor(itemId);
  if (sockets.length === 0) return [];

  const weights = gemFillWeights(epWeights, opts.spec);
  const base = sockets.map((_, i) => gems[i] ?? 0);
  const matched = fillEmpties(sockets, base, palette, weights, true, opts);
  const free = fillEmpties(sockets, base, palette, weights, false, opts);
  return layoutScore(itemId, sockets, free, weights) >
    layoutScore(itemId, sockets, matched, weights)
    ? free
    : matched;
}

/**
 * Softcaps: hit / expertise EP overstates gems on capped raid sets.
 * Used only for candidate socket fills — meta-repair keeps full EP weights.
 *
 * Which stats are softcapped is the spec's own question, and getting it wrong
 * is silent in both directions: zeroing melee hit for a caster leaves spell hit
 * gems overvalued *and* discards nothing, while zeroing expertise for a hunter
 * suppresses a stat the spec was never going to gem anyway. The profile answers
 * both — `hitStat` names the one hit stat that softcaps, and `trackExpertise`
 * says whether expertise is a cap this spec has at all.
 */
export function gemFillWeights(
  epWeights: EpWeightRecord,
  spec?: DetectedSpecId
): Record<string, number> {
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
  opts: FillEmptyOpts
): number[] {
  const out = [...base];
  const usedUnique = new Set(opts.usedUnique ?? []);
  for (const id of out) {
    const g = getGem(id);
    if (g?.unique) usedUnique.add(id);
  }

  for (let i = 0; i < sockets.length; i++) {
    if ((out[i] ?? 0) > 0) continue;
    const placed = out.filter((id) => id > 0);
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
      opts.spec
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
  spec: DetectedSpecId | undefined
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
    const preferredIds =
      spec === undefined ? PREFERRED_META_IDS : SPEC_PREFERRED_METAS[spec];
    // No recorded preference: leave the socket empty rather than fall through
    // to the EP pick below. EP cannot rank metas — nine of eighteen score
    // 0.00 — so "best by EP" would be an arbitrary gem wearing the authority
    // of a measurement, and inheriting another spec's meta would be worse.
    if (!preferredIds) return undefined;
    for (const preferred of preferredIds) {
      const hit = eligible.find((e) => e.gem.id === preferred);
      if (hit) return hit.gem;
    }
  }

  let bestEp = -Infinity;
  for (const e of eligible) {
    if (e.ep > bestEp) bestEp = e.ep;
  }

  const near = eligible.filter((e) => bestEp - e.ep <= META_NEAR_EP);
  const pool = near.length > 0 ? near : eligible;

  if (!metaCtx) {
    return pool.reduce((a, b) => (b.ep > a.ep ? b : a)).gem;
  }

  let best: { gem: GemEntry; ep: number; deficit: number } | undefined;
  for (const e of pool) {
    const afterDeficit = metaDeficit(
      metaCtx.metaId,
      gemColorCounts([...metaCtx.setGemIds, e.gem.id])
    );
    if (
      !best ||
      afterDeficit < best.deficit ||
      (afterDeficit === best.deficit && e.ep > best.ep)
    ) {
      best = { gem: e.gem, ep: e.ep, deficit: afterDeficit };
    }
  }

  return best?.gem;
}

function layoutScore(
  itemId: number,
  sockets: readonly number[],
  gemIds: readonly number[],
  epWeights: EpWeightRecord
): number {
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
