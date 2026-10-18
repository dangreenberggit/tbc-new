import { describe, expect, it } from 'vitest';

import { testItem, testSourcesOf } from '../testing/db_pool';
import { loadEnglishBundles } from '../testing/locales';
import { rowSourceDetail } from './format';

const sourcesOfId = (id: number) => {
	const item = testItem(id);
	if (!item) throw new Error(`db.json has no item ${id}`);
	return testSourcesOf(item);
};

describe('sourcesOf over the fork db.json and tier-exchange.json', () => {
	it('gives a tier piece its token from the exchange file, with the token id', () => {
		expect(sourcesOfId(29073)).toEqual([
			{ kind: 'token', zone: 'Karazhan', boss: 'Prince Malchezaar', token: 'Helm of the Fallen Champion', tokenId: 29760 },
		]);
	});

	it('gives a Sunmote upgrade its base item as the token, at the base item’s drop', () => {
		expect(sourcesOfId(34386)).toEqual([{ kind: 'token', zone: 'Sunwell Plateau', boss: 'Kalecgos', token: 'Sunmote + Pantaloons of Calming Strife' }]);
	});

	it('gives a Gladiator piece one arena source with no season', () => {
		expect(sourcesOfId(33688)).toEqual([{ kind: 'pvp', via: 'arena' }]);
	});

	it('gives an epic wowsims states no source for one unknown source', () => {
		expect(sourcesOfId(28645)).toEqual([{ kind: 'unknown' }]);
	});

	it('files a Magisters’ Terrace heroic drop under the zone, marked heroic, and never under the heroic bucket', () => {
		expect(sourcesOfId(34472)).toEqual([{ kind: 'raid', zone: "Magisters' Terrace", boss: 'Priestess Delrissa', heroic: true }]);
	});

	it('gives a heroic drop elsewhere one heroic source naming its dungeon', () => {
		expect(sourcesOfId(29240)).toEqual([{ kind: 'heroic', dungeon: 'Mana-Tombs' }]);
	});

	it('names a craft’s profession once and a reputation vendor’s faction and standing', () => {
		expect(sourcesOfId(34370)).toEqual([{ kind: 'crafted', profession: 'Leatherworking' }]);
		expect(sourcesOfId(29119)).toEqual([{ kind: 'rep', faction: 'The Consortium', standing: 'Exalted' }]);
	});
});

describe('the Source cell text from wowsims facts', () => {
	loadEnglishBundles();

	// The text these rows had before the run-time pool: the main repo's data/tab-fixtures/ret-p3-p2.json at 199b3289,
	// recorded from the bundled universes.
	it('equals the bundled universes’ text for a db raid row and a token row', () => {
		const row = (id: number) => {
			const sources = sourcesOfId(id);
			return { source: sources[0]!, sources };
		};
		expect(rowSourceDetail(row(32332))).toBe('Black Temple · Reliquary of the Lost');
		expect(rowSourceDetail(row(30993))).toBe('Black Temple (N) · The Illidari Council');
	});
});
