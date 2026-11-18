import type { UIItem } from '@generated/proto/ui';
import { getPVPSeasonFromItem, isPVPItem } from '@sim/proto/items';
import type { Sim } from '@sim/sim';

/**
 * Whether the gear selector's `ItemSource` (`ui/features/gear/components/SelectorModal/ItemSource.tsx`)
 * renders anything for `item`. A component cannot tell its parent it rendered nothing, so this
 * follows its branches in order; `item_source.test.tsx` fails when the two disagree.
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
 * The boss an npc name holds when `tools/database/atlasloot.go` overran its AtlasLoot
 * key, else undefined: on some Tier 0.5 boss lines its lazy pattern runs past the
 * key, naming npc 16097 `Isalien"].." - "..format(AL["Tier %s Sets`. The key's
 * closing `"]` marks the overrun; a real name with quotes (`Eric "The Swift"`) has none.
 */
export function overrunNpcKey(name: string): string | undefined {
	const end = name.indexOf('"]');
	return end === -1 ? undefined : name.slice(0, end);
}
