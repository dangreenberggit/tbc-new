import type { UIItem } from '@generated/proto/ui';
import { getPVPSeasonFromItem, isPVPItem } from '@sim/proto/items';
import type { Sim } from '@sim/sim';

/**
 * Whether upstream's `ItemSource` (`features/gear/components/SelectorModal/ItemSource.tsx`)
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
 * The boss an npc name holds when upstream's generator overran its AtlasLoot
 * key, else undefined. `tools/database/atlasloot.go:84` (a lazy
 * `AL(?:IL)?\["(.*?)"\]`) ran past the `AL["…"]` key on five Tier 0.5 boss
 * lines, so the site's database names npc 16097
 * `Isalien"].." - "..format(AL["Tier %s Sets` (ticket 680). The key's closing
 * `"]` inside a name marks the overrun, and the boss is the text before it;
 * `Eric "The Swift"` has quotes in a real name and no `"]`. The universe
 * builder's `GARBLED_NPC_NAME_RE` (`scripts/assemble_universe.py` in
 * tbc-gear-prio) applies the same test and recovery, so the tab and the
 * universe name the same boss.
 */
export function overrunNpcKey(name: string): string | undefined {
	const end = name.indexOf('"]');
	return end === -1 ? undefined : name.slice(0, end);
}
