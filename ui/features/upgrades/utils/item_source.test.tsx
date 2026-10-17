import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import { Profession } from '@generated/proto/common';
import { RepFaction, RepLevel, UIItem } from '@generated/proto/ui';
import { fakeHost } from '@sim/testing';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { itemSourceShows, overrunNpcKey } from './item_source';

const ZONE_ID = 10;
const { sim } = fakeHost({
	sim: {
		db: {
			getZone: (id: number) => (id === ZONE_ID ? { id, name: 'Black Temple' } : null),
			getNpc: (id: number) => (id === 20 ? { id, name: 'Illidan Stormrage' } : null),
		},
	},
});

const drop = (zoneId: number) => ({ source: { oneofKind: 'drop' as const, drop: { zoneId, npcId: 20, difficulty: 0, otherName: '', category: '' } } });
const quest = (name: string) => ({ source: { oneofKind: 'quest' as const, quest: { id: 1, name } } });
const rep = {
	source: { oneofKind: 'rep' as const, rep: { repFactionId: RepFaction.RepFactionTheConsortium, repLevel: RepLevel.RepLevelRevered, factionId: 0 } },
};
const soldBy = { source: { oneofKind: 'soldBy' as const, soldBy: { npcId: 5, npcName: "G'eras", zoneId: 0 } } };
const crafted = { source: { oneofKind: 'crafted' as const, crafted: { profession: Profession.Tailoring, spellId: 0 } } };

// One case per way out of `ItemSource`, the ones that render nothing included.
const CASES: Array<[string, Partial<UIItem>]> = [
	['no source, random suffixes', { randomSuffixOptions: [1] }],
	['no source, a gladiator piece of a known season', { name: "Wrathful Gladiator's Pauldrons" }],
	['no source, a gladiator name of no season', { name: "Unknown Gladiator's Pauldrons" }],
	['no source at all', { name: 'Plain Sword' }],
	['crafted', { sources: [crafted] }],
	['a drop in a known zone', { sources: [drop(ZONE_ID)] }],
	['a drop in a zone the database lacks', { sources: [drop(99)] }],
	['a named quest', { sources: [quest('A Call to Arms')] }],
	['an unnamed quest', { sources: [quest('')] }],
	['an unnamed quest, then reputation', { sources: [quest(''), rep] }],
	['sold by a vendor, then reputation', { sources: [soldBy, rep] }],
	['sold by a vendor', { sources: [soldBy] }],
	['sold by a vendor, a gladiator piece of no season', { name: "Unknown Gladiator's Pauldrons", sources: [soldBy] }],
];

afterEach(() => vi.restoreAllMocks());

describe('itemSourceShows', () => {
	it.each(CASES)('agrees with what ItemSource renders: %s', (_name, fields) => {
		// `ItemSource` logs an error for a drop zone the database lacks.
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const item = UIItem.create({ id: 1, name: 'Item', ...fields });
		const rendered = render(<ItemSource item={item} sim={sim} />).container.innerHTML !== '';
		expect(itemSourceShows(item, sim)).toBe(rendered);
	});

	it('shows a linked source for a raid drop, and none for an item with no source', () => {
		expect(itemSourceShows(UIItem.create({ sources: [drop(ZONE_ID)] }), sim)).toBe(true);
		expect(itemSourceShows(UIItem.create({ name: 'Plain Sword' }), sim)).toBe(false);
	});
});

describe('overrunNpcKey', () => {
	it('recovers the boss from a name the generator ran past its AtlasLoot key on (ticket 680)', () => {
		expect(overrunNpcKey('Isalien"].." - "..format(AL["Tier %s Sets')).toBe('Isalien');
		expect(overrunNpcKey('Lord Valthalak"].." - "..format(AL["Tier %s Sets')).toBe('Lord Valthalak');
	});

	it('leaves a real name alone, quotes included', () => {
		expect(overrunNpcKey('Eric "The Swift"')).toBeUndefined();
		expect(overrunNpcKey('Gruul the Dragonkiller')).toBeUndefined();
	});
});
