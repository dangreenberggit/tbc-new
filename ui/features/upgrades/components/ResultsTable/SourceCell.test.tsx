import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import { DungeonDifficulty, UIItem } from '@generated/proto/ui';
import { fakeHost } from '@sim/testing';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fixtureRow } from '../../testing/ranking_fixture';
import { SourceCell } from './SourceCell';

const ZONES: Record<number, string> = { 3959: 'Black Temple', 3717: 'The Slave Pens', 3457: 'Karazhan' };
const NPCS: Record<number, string> = { 22917: 'Illidan Stormrage', 17942: 'Quagmirran', 16816: 'Echo of Medivh' };
const { sim } = fakeHost({
	sim: {
		db: {
			getZone: (id: number) => (ZONES[id] ? { id, name: ZONES[id] } : null),
			getNpc: (id: number) => (NPCS[id] ? { id, name: NPCS[id] } : null),
		},
	},
});

const bossDrop = (zoneId: number, npcId: number, difficulty: DungeonDifficulty, category = '') =>
	UIItem.create({ id: 32332, sources: [{ source: { oneofKind: 'drop', drop: { zoneId, npcId, difficulty, otherName: '', category } } }] });

const upstreamLink = (item: UIItem) => render(<ItemSource item={item} sim={sim} />).container.querySelector('a')!.outerHTML;

const tabLink = (item: UIItem) =>
	render(
		<table>
			<tbody>
				<tr>
					<SourceCell row={fixtureRow(0)} item={item} sim={sim} />
				</tr>
			</tbody>
		</table>,
	).container.querySelector('td a')!.outerHTML;

// The Source cell draws upstream's drop-with-npc link itself (`dropSource`), so the tab and the gear picker show a
// boss drop the same way only while this copy follows upstream's `ItemSource`; a wowsims catch-up that changes that
// branch fails here. The only intended difference is the no-break space before the difficulty mark (ticket 607).
describe('SourceCell draws a boss drop as upstream’s ItemSource does', () => {
	it.each([
		['a raid boss', bossDrop(3959, 22917, DungeonDifficulty.DifficultyNormal)],
		['a heroic dungeon boss', bossDrop(3717, 17942, DungeonDifficulty.DifficultyHeroic)],
		['a drop with a category', bossDrop(3457, 16816, DungeonDifficulty.DifficultyNormal, 'Chess Event')],
		['an unknown difficulty', bossDrop(3959, 22917, DungeonDifficulty.DifficultyUnknown)],
	])('for %s', (_, item) => {
		const tab = tabLink(item);
		expect(tab).toContain('&nbsp;(');
		expect(tab.replaceAll('&nbsp;', ' ')).toBe(upstreamLink(item));
	});
});
