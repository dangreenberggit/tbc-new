/** Types shared by `RankInput` and `GearSource`. */

export type Region = 'US' | 'EU' | 'KR' | 'TW' | 'CN';

export type CharacterRef = {
	region: Region;
	realm: string;
	name: string;
};

/**
 * A spec this engine can rank: one with a preset and a candidate item list.
 *
 * Every per-spec engine table (`CAP_PROFILE_BY_SPEC`, `SPEC_PREFERRED_METAS`,
 * `PRESET_ID_BY_SPEC`) is a total `Record<SpecId, …>` holding a game fact with
 * no safe default, so adding a member without filling each is a compile error.
 */
export type SpecId = 'balance' | 'feral' | 'hunter' | 'mage' | 'ret' | 'shadow' | 'rogue' | 'ele' | 'enh' | 'warlock' | 'warrior';

/**
 * A spec this engine can *identify*, a wider set than it can rank.
 * candidate-gems.ts's SPEC_PREFERRED_METAS keys on it. Nothing in the tab
 * produces "feral-tank": the page already knows its own spec.
 */
export type DetectedSpecId = SpecId | 'feral-tank';

/** Inclusive content-tier filter 1–5. */
export type ContentPhase = 1 | 2 | 3 | 4 | 5;

export type FightRef = {
	reportCode: string;
	fightId: number;
};

export type Race =
	| 'RaceHuman'
	| 'RaceDwarf'
	| 'RaceNightElf'
	| 'RaceGnome'
	| 'RaceDraenei'
	| 'RaceOrc'
	| 'RaceUndead'
	| 'RaceTauren'
	| 'RaceTroll'
	| 'RaceBloodElf';
