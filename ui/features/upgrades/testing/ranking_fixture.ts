import type { RankedItem, Ranking } from '../model/engine/rank';
import type { StoppedRanking } from '../model/run_state';

/**
 * A small finished ranking for the tab's unit tests. Rows 0-5 are trimmed
 * from the repo's recorded `data/tab-fixtures/ret-p3-p2.json`: four ranked
 * rows, one set row (Lightbringer Breastplate, renumbered from rank 16 to 5)
 * and one row below the cutoff, with the recording's numbers so a format test
 * reads real magnitudes. P1 tests read those six by index.
 *
 * Rows 6-10 are appended so that each results feature has a row to show, and
 * the one substitution is there for the same reason. No recorded fixture has
 * a removed-worn line, an owned row above the cutoff or a substitution, so
 * those figures and flags are made up; the appended rows are therefore not in
 * engine order, which `applyView` does not need.
 */
export const RANKING_FIXTURE: Ranking = {
	contentHash: 'fixture:ret-p3-p2-trimmed',
	cutoff: { absDps: 3 },
	fight: { reportCode: 'current-page', fightId: 0, encounterName: 'Current page settings', route: 'report-events', confidence: 1 },
	baseline: { dps: 2084.163576929428, stdev: 120.06955354097485, metaAdjusted: false },
	assumptions: {
		maxPhase: 3,
		seeds: [11, 22, 33, 44, 55],
		iterations: 3000,
		race: 'RaceBloodElf',
		presetId: 'ret/current-page-settings',
		standing: [{ id: 'race', detail: 'Race assumed RaceBloodElf from the pinned preset.' }],
	},
	substitutions: [
		{
			field: 'Warglaive of Azzinoth',
			detail: 'A sim of this item failed, so that try was left out of the ranking.\nitem 32837, slot mainhand: panic: runtime error\ngoroutine 1 [running]:\nmain.main()',
		},
	],
	caps: {
		hit: {
			rating: 83.307699,
			capRating: 141.92309699999998,
			gap: 58.615397999999985,
			capUncertainty: 15.769233,
			assumedRace: 'RaceBloodElf',
			talentHitAssumed: { talent: 'Precision', points: 3, maxPoints: 3 },
		},
		expertise: { rating: 95, capRating: null, gap: null },
	},
	items: [
		{
			rank: 1,
			itemId: 32332,
			name: 'Torch of the Damned',
			slot: 'weapon',
			source: { kind: 'raid', zone: 'Black Temple', boss: 'Reliquary of the Lost' },
			deltaDps: 45.74542784209225,
			deltaPct: 2.194905829296202,
			se: 0.12220576391649256,
			seMethod: 'paired-replicate',
			bisTags: ['BiS'],
			curatedSets: ['p3'],
			bisSets: ['p3'],
			belowCutoff: false,
		},
		{
			rank: 2,
			itemId: 30902,
			name: "Cataclysm's Edge",
			slot: 'weapon',
			source: { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde' },
			deltaDps: 28.561145667030452,
			deltaPct: 1.370388868857848,
			se: 0.1780748095609935,
			seMethod: 'paired-replicate',
			bisTags: [],
			belowCutoff: false,
		},
		{
			rank: 3,
			itemId: 32235,
			name: 'Cursed Vision of Sargeras',
			slot: 'head',
			source: { kind: 'raid', zone: 'Black Temple', boss: 'Illidan Stormrage' },
			deltaDps: 20.581885779610822,
			deltaPct: 0.9875369672247059,
			se: 0.004228411629352429,
			seMethod: 'paired-replicate',
			bisTags: ['BiS'],
			curatedSets: ['p3'],
			bisSets: ['p3'],
			belowCutoff: false,
		},
		{
			rank: 4,
			itemId: 33688,
			name: "Vengeful Gladiator's Greatsword",
			slot: 'weapon',
			source: { kind: 'pvp', via: 'arena' },
			deltaDps: 17.052767765586303,
			deltaPct: 0.8182067834958487,
			se: 0.16571415224645464,
			seMethod: 'paired-replicate',
			bisTags: [],
			belowCutoff: false,
		},
		{
			rank: 5,
			itemId: 30990,
			name: 'Lightbringer Breastplate',
			slot: 'chest',
			source: {
				kind: 'token',
				zone: 'Black Temple',
				token: 'Chestguard of the Forgotten Conqueror',
				boss: 'Illidan Stormrage',
			},
			deltaDps: 3.947966739203366,
			deltaPct: 0.18942691365040817,
			se: 2.1949254078559264,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: false,
			hitRegression: { lost: 2, gapAfter: 60.615397999999985 },
			setContext: {
				setId: 680,
				setName: 'Lightbringer Battlegear',
				piecesWornBefore: 0,
				piecesAfterSwap: 1,
				nextThreshold: null,
				crossesThreshold: false,
				stepRanking: true,
				futureBonuses: [
					{ threshold: 2, piecesNeeded: 2, sameGearDps: -2.6294543346361934, sameGearSe: 3.181413317205621, belowGate: true },
					{ threshold: 4, piecesNeeded: 4, sameGearDps: 0, sameGearSe: 3.2085991552325717, belowGate: true },
				],
				singleDeltaDps: 3.947966739203366,
			},
		},
		{
			rank: null,
			itemId: 32373,
			name: 'Helm of the Illidari Shatterer',
			slot: 'head',
			source: { kind: 'raid', zone: 'Black Temple', boss: 'The Illidari Council' },
			deltaDps: 2.9135247582489683,
			deltaPct: 0.13979347832867456,
			se: 2.1951905927084745,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: true,
			hitDriven: true,
		},
		{
			// Recorded figures. The old percentage rule admitted it (3.32 DPS < 3.4, 0.159% ≥ 0.15%); it clears the flat 3 DPS bar (ADR-0037).
			rank: 6,
			itemId: 30905,
			name: 'Midnight Chestguard',
			slot: 'chest',
			source: { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde' },
			deltaDps: 3.3196,
			deltaPct: 0.1593,
			se: 2.19,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: false,
			hitDriven: true,
		},
		{
			rank: 7,
			itemId: 28830,
			name: 'Dragonspine Trophy',
			slot: 'trinket',
			slotChoice: 'trinket1',
			source: { kind: 'raid', zone: "Gruul's Lair", boss: 'Gruul the Dragonkiller' },
			deltaDps: 5.2,
			deltaPct: 0.2495,
			se: 2.2,
			seMethod: 'independent',
			bisTags: ['Alt'],
			belowCutoff: false,
			owned: true,
		},
		{
			rank: 8,
			itemId: 29993,
			name: 'Twinblade of the Phoenix',
			slot: 'weapon',
			source: { kind: 'raid', zone: 'Tempest Keep', boss: "Kael'thas Sunstrider" },
			deltaDps: 4.1671,
			deltaPct: 0.2,
			se: 2.2,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: false,
			removedItems: [{ itemId: 30882, slot: 'offhand' }],
		},
		{
			rank: 9,
			itemId: 30993,
			name: 'Lightbringer Greaves',
			slot: 'legs',
			source: {
				kind: 'token',
				zone: 'Black Temple',
				token: 'Leggings of the Forgotten Conqueror',
				boss: 'The Illidari Council',
				tokenId: 31098,
			},
			sources: [
				{ kind: 'raid', zone: 'Black Temple', boss: 'The Illidari Council' },
				{
					kind: 'token',
					zone: 'Black Temple',
					token: 'Leggings of the Forgotten Conqueror',
					boss: 'The Illidari Council',
					tokenId: 31098,
				},
			],
			deltaDps: 3.62,
			deltaPct: 0.1737,
			se: 2.2,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: false,
		},
		{
			rank: 10,
			itemId: 30989,
			name: 'Lightbringer Faceguard',
			slot: 'head',
			source: { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde' },
			deltaDps: 4.42,
			deltaPct: 0.2121,
			se: 2.2,
			seMethod: 'independent',
			bisTags: [],
			belowCutoff: false,
			setContext: {
				setId: 680,
				setName: 'Lightbringer Battlegear',
				piecesWornBefore: 0,
				piecesAfterSwap: 1,
				nextThreshold: null,
				crossesThreshold: false,
				singleBreaks: [{ setId: 627, setName: 'Crystalforge Battlegear', threshold: 2, dps: 18.43 }],
				singleDeltaDps: 4.42,
			},
		},
	],
	complete: true,
};

/** A row Stop never reached, with the placeholder figures the engine gives one. */
const unsimmed = (itemId: number, name: string, slot: RankedItem['slot']): RankedItem => ({
	rank: null,
	itemId,
	name,
	slot,
	source: { kind: 'raid', zone: 'Black Temple' },
	deltaDps: 0,
	deltaPct: 0,
	se: 0,
	seMethod: 'independent',
	simmed: false,
	bisTags: [],
	belowCutoff: false,
});

/**
 * What Stop returns for the same run: every row above in engine order (simmed
 * rows by ΔDPS, highest first), then two rows Stop never simmed.
 */
export const STOPPED_FIXTURE: StoppedRanking = {
	...RANKING_FIXTURE,
	items: [
		...[...RANKING_FIXTURE.items].sort((a, b) => b.deltaDps - a.deltaDps),
		unsimmed(32366, "Shadowmaster's Boots", 'feet'),
		unsimmed(32568, 'Swiftsteel Bracers', 'wrist'),
	],
	complete: false,
	durationMs: 41_200,
};

/** One of the fixture's rows, for tests that name rows; throws on an index the fixture does not have. */
export function fixtureRow(index: number): RankedItem {
	const row = RANKING_FIXTURE.items[index];
	if (!row) throw new Error(`RANKING_FIXTURE has no row ${index}`);
	return row;
}
