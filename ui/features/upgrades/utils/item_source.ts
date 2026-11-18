import type { UIItem } from '@generated/proto/ui';
import { getPVPSeasonFromItem, isPVPItem } from '@sim/proto/items';
import type { Sim } from '@sim/sim';

/**
 * Whether the gear selector's `ItemSource` (`ui/features/gear/components/SelectorModal/ItemSource.tsx`)
 * renders anything for `item`. A component cannot tell its parent that it
 * rendered nothing, so this follows its branches in its order;
 * `item_source.test.tsx` renders `ItemSource` for each branch and fails when
 * the two disagree.
 */
export function itemSourceShows(item: UIItem, sim: Sim): boolean {
	const pvpShows = () => isPVPItem(item) && Boolean(getPVPSeasonFromItem(item));
	const [first] = item.sources;
	if (!first) return item.randomSuffixOptions.length > 0 || pvpShows();
	const { source } = first;
	if (source.oneofKind === 'crafted') return true;
	if (source.oneofKind === 'drop') return sim.db.getZone(source.drop.zoneId) !== null;
	if (source.oneofKind === 'quest' && source.quest.name) return true;
	if (item.sources.some(entry => entry.source.oneofKind === 'rep')) return true;
	if (isPVPItem(item)) return pvpShows();
	return source.oneofKind === 'soldBy';
}

/**
 * The boss an npc name holds when the database generator overran its AtlasLoot
 * key, else undefined. The lazy `AL(?:IL)?\["(.*?)"\]` in
 * `tools/database/atlasloot.go` runs past the `AL["…"]` key on five Tier 0.5
 * boss lines, so the database names npc 16097
 * `Isalien"].." - "..format(AL["Tier %s Sets`. The key's closing `"]` inside a
 * name marks the overrun, and the boss is the text before it;
 * `Eric "The Swift"` has quotes in a real name and no `"]`.
 */
export function overrunNpcKey(name: string): string | undefined {
	const end = name.indexOf('"]');
	return end === -1 ? undefined : name.slice(0, end);
}
