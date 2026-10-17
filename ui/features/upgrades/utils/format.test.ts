import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import i18n from '@i18n/config';
import { describe, expect, it } from 'vitest';

import { RankError } from '../model/engine/rank';
import type { RunProgressView } from '../model/run_progress';
import {
	describeRunError,
	fixtureOutcomeText,
	formatDelta,
	formatDps,
	formatSeconds,
	progressBarOf,
	progressLabel,
	progressStageOf,
	rowNamesHiddenSource,
	rowShownSourceLabel,
	rowSourceDetail,
	rowSourceLabel,
	simSlotLabel,
	slotLabel,
	sortLabelsFor,
	sourceDetail,
	sourceKeyLabel,
	sourceLabel,
	substitutionText,
} from './format';

loadEnglishBundles({ character: true });

const view = (overrides: Partial<RunProgressView>): RunProgressView => ({
	phase: 'preparing',
	stage: 'resolving',
	boundary: null,
	concurrency: 1,
	qualifyingRows: 0,
	...overrides,
});

describe('formatDelta', () => {
	it('signs a gain and keeps one decimal', () => {
		expect(formatDelta(45.745)).toBe('+45.7');
	});

	it('takes the sign of a loss from the number, never a doubled sign', () => {
		expect(formatDelta(-41)).toBe('-41.0');
	});

	it('shows no sign on zero', () => {
		expect(formatDelta(0)).toBe('0.0');
	});
});

describe('formatDps and formatSeconds', () => {
	it('round to one decimal', () => {
		expect(formatDps(2084.1635)).toBe('2,084.2');
		expect(formatSeconds(2549)).toBe('2.5');
	});
});

describe('slotLabel', () => {
	it('names a pool slot by its sim slot, with the page’s own slot names', () => {
		expect(slotLabel({ slot: 'head' })).toBe('Head');
		expect(slotLabel({ slot: 'weapon' })).toBe('Main Hand');
		expect(slotLabel({ slot: 'finger', slotChoice: 'finger2' })).toBe('Ring 2');
	});
});

describe('simSlotLabel', () => {
	it('names a sim slot as the page does, so a removed off-hand reads "Off Hand", not "offhand"', () => {
		expect(simSlotLabel('offhand')).toBe('Off Hand');
		expect(simSlotLabel('mainhand')).toBe('Main Hand');
	});
});

describe('rowSourceLabel', () => {
	it('names the first source of a row that has several, as the engine orders them', () => {
		const raid = { kind: 'raid', zone: 'Black Temple', boss: 'Illidan' } as const;
		const badge = { kind: 'badge', cost: 75 } as const;
		expect(rowSourceLabel({ source: badge, sources: [raid, badge] })).toBe('Black Temple');
		expect(rowSourceLabel({ source: badge })).toBe('Badge vendor');
	});
});

describe('the Source cell under Filter by source', () => {
	const hyjal = { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde' } as const;
	const blackTemple = { kind: 'raid', zone: 'Black Temple', boss: 'Illidan' } as const;
	const badge = { kind: 'badge', cost: 75 } as const;
	const twoRaids = { source: hyjal, sources: [hyjal, blackTemple] };
	const badgeOrRaid = { source: badge, sources: [badge, blackTemple] };

	it('names the first shown source of a row whose first source is hidden', () => {
		expect(rowNamesHiddenSource(twoRaids, ['Hyjal Summit'])).toBe(true);
		expect(rowShownSourceLabel(twoRaids, ['Hyjal Summit'])).toBe('Black Temple');
	});

	it('says a row names a hidden source when any of its sources is hidden, not only the first', () => {
		expect(rowNamesHiddenSource(twoRaids, ['Black Temple'])).toBe(true);
		expect(rowShownSourceLabel(twoRaids, ['Black Temple'])).toBe('Hyjal Summit');
	});

	// The filter files such a row under its zone only, but the cell must not name a bucket the user hid either.
	it('keys a zoneless source inside a row with a zone by its own bucket', () => {
		expect(rowNamesHiddenSource(badgeOrRaid, ['Badge vendor'])).toBe(true);
		expect(rowShownSourceLabel(badgeOrRaid, ['Badge vendor'])).toBe('Black Temple');
		expect(rowNamesHiddenSource(badgeOrRaid, ['Hyjal Summit'])).toBe(false);
	});

	it('names no hidden source when nothing the row comes from is hidden', () => {
		expect(rowNamesHiddenSource(twoRaids, [])).toBe(false);
		expect(rowNamesHiddenSource({ source: badge }, ['Crafted'])).toBe(false);
		expect(rowShownSourceLabel(twoRaids, [])).toBe('Hyjal Summit');
	});

	it('falls back to the first source when every source is hidden', () => {
		expect(rowShownSourceLabel(twoRaids, ['Hyjal Summit', 'Black Temple'])).toBe('Hyjal Summit');
	});
});

describe('sourceDetail', () => {
	it('names a tier token’s zone, difficulty and boss, as a drop row does, and not the token', () => {
		const token = { kind: 'token', zone: 'Black Temple', boss: 'The Illidari Council', token: 'Leggings of the Forgotten Protector' } as const;
		expect(sourceDetail(token)).toBe('Black Temple (N) · The Illidari Council');
		expect(sourceDetail({ kind: 'token', zone: 'Black Temple', token: 'Leggings of the Forgotten Protector' })).toBe('Black Temple (N)');
	});

	// Five-man drops mix Normal and Heroic in upstream's db.json, so a raid-kind row prints no difficulty.
	it('names a drop’s zone and boss, and the zone alone when no boss is recorded', () => {
		expect(sourceDetail({ kind: 'raid', zone: 'The Mechanar', boss: 'Pathaleon the Calculator' })).toBe('The Mechanar · Pathaleon the Calculator');
		expect(sourceDetail({ kind: 'raid', zone: 'Hyjal Summit' })).toBe('Hyjal Summit');
	});

	it('names a heroic dungeon after its kind', () => {
		expect(sourceDetail({ kind: 'heroic', dungeon: 'The Mechanar' })).toBe('Heroic dungeon · The Mechanar');
	});

	it('names a reputation item’s faction and standing', () => {
		expect(sourceDetail({ kind: 'rep', faction: 'The Scale of the Sands', standing: 'Revered' })).toBe('The Scale of the Sands · Revered');
	});

	it('names a PvP item’s currency, and its season when one is recorded', () => {
		expect(sourceDetail({ kind: 'pvp', via: 'arena', season: 3 })).toBe('PvP vendor · Arena, season 3');
		expect(sourceDetail({ kind: 'pvp', via: 'arena' })).toBe('PvP vendor · Arena');
		expect(sourceDetail({ kind: 'pvp', via: 'honor' })).toBe('PvP vendor · Honor');
		withTranslation('upgrades_tab.source_detail.honor', 'Ehre', () => expect(sourceDetail({ kind: 'pvp', via: 'honor' })).toBe('PvP vendor · Ehre'));
	});

	it('names a badge, crafted, world or unrecorded source by its kind alone, as before', () => {
		expect(sourceDetail({ kind: 'badge', cost: 75 })).toBe('Badge vendor');
		expect(sourceDetail({ kind: 'crafted', profession: 'Blacksmithing' })).toBe('Crafted');
		expect(sourceDetail({ kind: 'world' })).toBe('World drop');
		expect(sourceDetail({ kind: 'unknown' })).toBe('Source not recorded');
	});
});

describe('rowSourceDetail', () => {
	const token = { kind: 'token', zone: 'Black Temple', boss: 'The Illidari Council', token: 'Leggings of the Forgotten Protector' } as const;
	const hyjal = { kind: 'raid', zone: 'Hyjal Summit', boss: 'Archimonde' } as const;
	const tokenOrHyjal = { source: token, sources: [token, hyjal] };

	it('names the first source of a row with its detail', () => {
		expect(rowSourceDetail(tokenOrHyjal)).toBe('Black Temple (N) · The Illidari Council');
		expect(rowSourceDetail({ source: { kind: 'pvp', via: 'arena', season: 3 } })).toBe('PvP vendor · Arena, season 3');
	});

	// The detail is the shown source's only, so a kept row's cell never names a hidden zone.
	it('names the first shown source while the first is hidden, else the first', () => {
		expect(rowSourceDetail(tokenOrHyjal, ['Black Temple'])).toBe('Hyjal Summit · Archimonde');
		expect(rowSourceDetail(tokenOrHyjal, ['Hyjal Summit'])).toBe('Black Temple (N) · The Illidari Council');
		expect(rowSourceDetail(tokenOrHyjal, ['Black Temple', 'Hyjal Summit'])).toBe('Black Temple (N) · The Illidari Council');
	});
});

describe('sortLabelsFor', () => {
	it('sorts the slot and source columns on the text their cells show', () => {
		const row = { slot: 'finger', slotChoice: 'finger2', source: { kind: 'badge', cost: 75 } } as const;
		expect(sortLabelsFor([]).slot(row)).toBe('Ring 2');
		expect(sortLabelsFor([]).source(row)).toBe('Badge vendor');
	});

	it('sorts a reputation or token row on the detail its cell shows, not on its bucket', () => {
		const rep = { slot: 'finger', source: { kind: 'rep', faction: 'The Scale of the Sands', standing: 'Revered' } } as const;
		const token = {
			slot: 'legs',
			source: { kind: 'token', zone: 'Black Temple', boss: 'The Illidari Council', token: 'Leggings of the Forgotten Protector' },
		} as const;
		expect(sortLabelsFor([]).source(rep)).toBe('The Scale of the Sands · Revered');
		expect(sortLabelsFor([]).source(token)).toBe('Black Temple (N) · The Illidari Council');
	});
});

describe('substitutionText', () => {
	it('shows a crash trace’s first line and says the rest is in the console, and leaves a one-line reason whole', () => {
		expect(substitutionText('panic: boom\ngoroutine 1')).toBe('panic: boom… (full text in the browser console)');
		expect(substitutionText('Kept the worn hit gems.')).toBe('Kept the worn hit gems.');
	});
});

/** Swaps one translation for the length of `check`, to show a label is read from the locale file. */
const withTranslation = (key: string, value: string, check: () => void) => {
	const original = i18n.t(key, { ns: 'upgrades' });
	i18n.addResource('en', 'upgrades', key, value);
	try {
		check();
	} finally {
		i18n.addResource('en', 'upgrades', key, original);
	}
};

describe('sourceLabel', () => {
	it('names a zone for a drop and the source kind’s translation otherwise', () => {
		expect(sourceLabel({ kind: 'raid', zone: 'Black Temple', boss: 'Illidan' })).toBe('Black Temple');
		expect(sourceLabel({ kind: 'badge', cost: 75 })).toBe('Badge vendor');
		withTranslation('upgrades_tab.sources.badge', 'Marken', () => expect(sourceLabel({ kind: 'badge', cost: 75 })).toBe('Marken'));
	});
});

describe('sourceKeyLabel', () => {
	it('names a zone key as the zone and a source bucket key through its kind’s translation', () => {
		expect(sourceKeyLabel('Black Temple')).toBe('Black Temple');
		expect(sourceKeyLabel('Badge vendor')).toBe('Badge vendor');
		withTranslation('upgrades_tab.sources.badge', 'Marken', () => expect(sourceKeyLabel('Badge vendor')).toBe('Marken'));
	});

	// Ticket 645: some of these rings are quest rewards, so the bucket no longer claims a vendor; the saved key keeps its text.
	it('names the reputation bucket "Reputation" while its key stays "Reputation vendor"', () => {
		expect(sourceKeyLabel('Reputation vendor')).toBe('Reputation');
	});
});

describe('fixtureOutcomeText', () => {
	it('counts the rows of a loaded fixture, and gives the detail or the reason of a refused one', () => {
		expect(fixtureOutcomeText({ ok: true, rows: 467 })).toBe('Loaded a fixture with 467 rows.');
		expect(fixtureOutcomeText({ ok: false, reason: 'spec', detail: 'fixture is feral, page is ret' })).toBe(
			'Fixture rejected: fixture is feral, page is ret',
		);
		expect(fixtureOutcomeText({ ok: false, reason: 'phase missing' })).toBe('Fixture rejected: phase missing');
		expect(fixtureOutcomeText({ ok: false, reason: 'not_json' })).toBe('The file is not JSON.');
	});
});

describe('describeRunError', () => {
	it('explains a spec the engine has no data for', () => {
		expect(describeRunError(new RankError('not-implemented', 'no data'))).toBe('This spec has no ranking data yet.');
	});

	it('quotes any other failure', () => {
		expect(describeRunError(new Error('worker died'))).toBe('Ranking failed: worker died');
		expect(describeRunError('boom')).toBe('Ranking failed: boom');
	});
});

describe('progress', () => {
	it('reads the stage while preparing and the phase after', () => {
		expect(progressStageOf(null)).toBe('resolving');
		expect(progressStageOf(view({ stage: 'building-pool' }))).toBe('building-pool');
		expect(progressStageOf(view({ phase: 'replication', stage: 'simming' }))).toBe('replication');
	});

	it('labels each stage', () => {
		expect(progressLabel('building-pool')).toBe('Building the candidate pool…');
		expect(progressLabel('candidates')).toBe('Simming candidates');
	});

	it('fills the bar from the sims done', () => {
		expect(progressBarOf(view({ phase: 'candidates', stage: 'simming', done: 3, total: 12 }))).toEqual({ current: 3, total: 12 });
	});
});
