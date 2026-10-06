/**
 * Domain refs shared by RankInput and the GearSource seam.
 *
 * PORTED from packages/core/src/types.ts, unchanged.
 *
 * `SpecId` used to be narrowed to ret/feral here because that was what this
 * fork's universes and EP weights covered. Both now cover all eleven DPS
 * specs, so the narrowing is gone and this file matches its source.
 */

export type Region = "US" | "EU" | "KR" | "TW" | "CN";

export type CharacterRef = {
  region: Region;
  realm: string;
  name: string;
};

/**
 * A spec this engine can rank — i.e. one with a preset and a universe.
 *
 * Every per-spec engine table is a **total** `Record<SpecId, …>`, so adding a
 * member here without filling each of them is a compile error rather than a
 * silent inheritance of ret's numbers. That is the point of the totality: the
 * tables that matter (`CAP_PROFILE_BY_SPEC`, `CUTOFF_BY_SPEC`,
 * `SPEC_PREFERRED_METAS`, `PRESET_ID_BY_SPEC`) each encode a per-spec game fact
 * that has no safe default.
 */
export type SpecId =
  | "balance"
  | "feral"
  | "hunter"
  | "mage"
  | "ret"
  | "shadow"
  | "rogue"
  | "ele"
  | "enh"
  | "warlock"
  | "warrior";

/**
 * A spec this engine can *identify*, which is a wider set than it can rank.
 * Carried from packages/core for type compatibility with ported modules
 * (candidate-gems.ts's SPEC_PREFERRED_METAS keys on this) even though
 * spec.ts itself is not ported — the page already knows its own spec, so
 * nothing in the fork ever produces a "feral-tank" value here.
 */
export type DetectedSpecId = SpecId | "feral-tank";

/** Inclusive content-tier filter 1–5. */
export type ContentPhase = 1 | 2 | 3 | 4 | 5;

export type FightRef = {
  reportCode: string;
  fightId: number;
};

export type Race =
  | "RaceHuman"
  | "RaceDwarf"
  | "RaceNightElf"
  | "RaceGnome"
  | "RaceDraenei"
  | "RaceOrc"
  | "RaceUndead"
  | "RaceTauren"
  | "RaceTroll"
  | "RaceBloodElf";
