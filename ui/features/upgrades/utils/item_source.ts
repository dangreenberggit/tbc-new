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
