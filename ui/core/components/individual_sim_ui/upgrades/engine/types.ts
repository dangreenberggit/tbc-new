/**
 * Domain refs shared by RankInput and the GearSource seam.
 *
 * PORTED from packages/core/src/types.ts. `SpecId` and `DetectedSpecId` are
 * narrowed to ret/feral because that is what this fork's universes and EP
 * weights cover (plan §2.5) — the standalone app's wider ambitions do not
 * apply here.
 */

export type Region = "US" | "EU" | "KR" | "TW" | "CN";

export type CharacterRef = {
  region: Region;
  realm: string;
  name: string;
};

/** A spec this engine can rank — i.e. one with a preset and a universe. */
export type SpecId = "ret" | "feral";

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
