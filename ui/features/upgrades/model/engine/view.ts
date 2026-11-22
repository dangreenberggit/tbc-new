/**
 * Sorts, filters and groups an existing `Ranking` for display. It runs no sims,
 * and nothing here changes `contentHash`.
 *
 * With `withSetPotential` on, rows sort and fall below the cutoff by their
 * DPS plus `rankableSetPotential` (set-potential.ts).
 */
import { type Cutoff, meetsCutoff } from './cutoff';
import { type ItemSource, sourceMatchesBoss } from './pool';
import type { RankedItem, Ranking } from './rank-types';
import { rankableSetPotential } from './set-potential';

// Until chunk C3 of the readability plan, the moved names stay importable from here.
export {
	type SetPotentialTerm,
	setCreditUnmeasured,
	bonusGearUnmeasured,
	setBonusSubLine,
	type SwapBreak,
	ownSwapBreaks,
	canBeCredited,
	crossingLabelCount,
	setPotentialTerms,
	type SetPotentialIncrement,
	setPotentialIncrements,
	setPotentialCredit,
	rankableSetPotential,
} from './set-potential';

export type ViewOptions = {
	pinBis?: boolean;
	raid?: string;
	boss?: string;
	groupBy?: 'rank' | 'slot' | 'raid';
	withSetPotential?: boolean;
};

export type ViewRow = RankedItem & {
	tieGroupId?: string;
	belowCutoffInView: boolean;
};

export type ViewResult = {
	rows: ViewRow[];
	shortlist: ViewRow[];
	belowCutoffCount: number;
	pinBisAvailable: boolean;
	groups?: Array<{ key: string; rows: ViewRow[] }>;
};

function sourcesOf(item: Pick<RankedItem, 'source' | 'sources'>): ItemSource[] {
	return item.sources ?? [item.source];
}

function matchesZone(item: RankedItem, zone: string): boolean {
	return sourcesOf(item).some(s => 'zone' in s && s.zone === zone);
}

function matchesBoss(item: RankedItem, zone: string | undefined, boss: string) {
	return sourcesOf(item).some(s => sourceMatchesBoss(s, boss, zone));
}

/** i18n keys for sources with no zone; format.ts translates them. */
export const ZONELESS_SOURCE_KEYS: Record<string, string> = {
	badge: 'Badge vendor',
	crafted: 'Crafted',
	rep: 'Reputation vendor',
	pvp: 'PvP vendor',
	world: 'World drop',
	heroic: 'Heroic dungeon',
	unknown: 'Source not recorded',
};

export function zoneKeyOf(item: Pick<RankedItem, 'source' | 'sources'>): string {
	for (const s of sourcesOf(item)) {
		if ('zone' in s) return s.zone;
	}
	return ZONELESS_SOURCE_KEYS[item.source.kind] ?? item.source.kind;
}

export type RaidFilterGroup = { key: string; options: string[] };

/**
 * Zones and zoneless buckets, each under its own group key, in that order.
 * `groups.flatMap(g => g.options)` gives the same options as one flat list.
 */
export function raidFilterGroups(items: readonly RankedItem[]): RaidFilterGroup[] {
	const zoneless = new Set(Object.values(ZONELESS_SOURCE_KEYS));
	const zones: string[] = [];
	const buckets: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const key = zoneKeyOf(item);
		if (seen.has(key)) continue;
		seen.add(key);
		(zoneless.has(key) ? buckets : zones).push(key);
	}
	const groups: RaidFilterGroup[] = [];
	if (zones.length > 0) groups.push({ key: 'zone', options: zones });
	if (buckets.length > 0) groups.push({ key: 'other', options: buckets });
	return groups;
}

function matchesRaidFilter(item: RankedItem, value: string): boolean {
	if (matchesZone(item, value)) return true;
	const key = zoneKeyOf(item);
	return key === value && !sourcesOf(item).some(s => 'zone' in s);
}

function tieWindow(a: ViewRow, b: ViewRow): number {
	const se = a.seMethod === b.seMethod ? Math.min(a.se, b.se) : Math.max(a.se, b.se);
	return se * 2;
}

function assignTieGroups(rows: ViewRow[], sortKey: (r: ViewRow) => number): void {
	const groupIdRef = { next: 1 };
	const byDelta = [...rows].sort((a, b) => sortKey(b) - sortKey(a));
	let groupStart = 0;

	const flush = (end: number) => {
		if (end - groupStart > 1) {
			const id = `tie-${groupIdRef.next}`;
			groupIdRef.next += 1;
			for (let i = groupStart; i < end; i += 1) byDelta[i]!.tieGroupId = id;
		}
	};

	for (let i = 1; i <= byDelta.length; i += 1) {
		const leader = byDelta[groupStart]!;
		const row = byDelta[i];
		const overlapsLeader = row !== undefined && sortKey(leader) - sortKey(row) <= tieWindow(row, leader);
		if (!overlapsLeader) {
			flush(i);
			groupStart = i;
		}
	}
}

function belowCutoffUnderView(item: RankedItem, withSetPotential: boolean, cutoff: Cutoff): boolean {
	if (!withSetPotential) return item.belowCutoff;
	const credit = rankableSetPotential(item, cutoff);
	if (credit === 0) return item.belowCutoff;
	return !meetsCutoff(item.deltaDps + credit, cutoff);
}

function sortKeyFor(withSetPotential: boolean, cutoff: Cutoff): (r: ViewRow) => number {
	return withSetPotential ? r => r.deltaDps + rankableSetPotential(r, cutoff) : r => r.deltaDps;
}

function compareRows(a: ViewRow, b: ViewRow, pinBis: boolean, sortKey: (r: ViewRow) => number): number {
	if (pinBis) {
		const ap = a.bisTags.includes('BiS') ? 0 : 1;
		const bp = b.bisTags.includes('BiS') ? 0 : 1;
		if (ap !== bp) return ap - bp;
	}
	const ak = sortKey(a);
	const bk = sortKey(b);
	if (ak !== bk) return bk - ak;
	const richness = b.bisTags.length - a.bisTags.length;
	if (richness !== 0) return richness;
	return a.itemId - b.itemId;
}

export function applyView(r: Ranking, v: ViewOptions = {}): ViewResult {
	const pinBis = v.pinBis ?? false;
	const zone = v.raid === undefined || v.raid === 'all' ? undefined : v.raid;
	const boss = v.boss === undefined || v.boss === 'all' ? undefined : v.boss;
	const sortKey = sortKeyFor(v.withSetPotential ?? false, r.cutoff);

	const rows: ViewRow[] = r.items
		.filter(item => {
			if (zone !== undefined && !matchesRaidFilter(item, zone)) return false;
			if (boss !== undefined && !matchesBoss(item, zone, boss)) return false;
			return true;
		})
		.map(item => ({
			...item,
			belowCutoffInView: belowCutoffUnderView(item, v.withSetPotential ?? false, r.cutoff),
		}));

	rows.sort((a, b) => compareRows(a, b, pinBis, sortKey));

	assignTieGroups(rows, sortKey);

	const pinBisAvailable = r.items.some(i => i.bisTags.includes('BiS'));
	const shortlist = rows.filter(row => !row.belowCutoffInView);
	const result: ViewResult = {
		rows,
		shortlist,
		belowCutoffCount: rows.length - shortlist.length,
		pinBisAvailable,
	};

	if (v.groupBy === 'slot' || v.groupBy === 'raid') {
		const keyOf = v.groupBy === 'slot' ? (i: ViewRow) => i.slot : zoneKeyOf;
		const groups = new Map<string, ViewRow[]>();
		for (const row of rows) {
			const key = keyOf(row);
			const bucket = groups.get(key);
			if (bucket) bucket.push(row);
			else groups.set(key, [row]);
		}
		result.groups = [...groups].map(([key, groupRows]) => ({
			key,
			rows: groupRows,
		}));
	}

	return result;
}
