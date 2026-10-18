/**
 * A candidate's sources from wowsims' own item facts (ticket 505): the item's
 * `sources` in db.json named through `sim.db.getZone`/`getNpc` and upstream's
 * name tables, upstream's `isPVPItem`, and the one exchange file the outer repo
 * copies in (`model/data/tier-exchange.json`: tier piece to token, Sunmote
 * upgrade to base item), because wowsims states no token or Sunmote exchange.
 * Upstream's `ItemSource` component builds its text inside JSX and exports no
 * helper, so the tab names the facts itself.
 */

import { DungeonDifficulty, type UIItem } from '@generated/proto/ui';
import { isPVPItem } from '@sim/proto/items';
import { professionNames, REP_FACTION_NAMES, REP_LEVEL_NAMES } from '@sim/proto/names';

import type { ItemSource } from '../model/engine/pool';
import { overrunNpcKey } from './item_source';

/** What the source facts read of the page's database (`sim.db`). */
export type SourceDb = {
	getZone(zoneId: number): { name: string } | null;
	getNpc(npcId: number): { name: string } | null;
	getItemById(id: number): UIItem | undefined;
};

/** The exchange file's rows, as `model/data/tier-exchange.json` holds them. */
export type TierExchange = {
	tokens: readonly { pieceId: number; tokenId: number; tokenName: string; zone: string; boss: string }[];
	sunmote: readonly { baseId: number; upgradeId: number }[];
};

/** The exchange file indexed by the item id a row gives a source to. */
export type ExchangeIndex = {
	tokenByPiece: ReadonlyMap<number, TierExchange['tokens'][number]>;
	baseByUpgrade: ReadonlyMap<number, number>;
};

export const indexExchange = (exchange: TierExchange): ExchangeIndex => ({
	tokenByPiece: new Map(exchange.tokens.map(row => [row.pieceId, row])),
	baseByUpgrade: new Map(exchange.sunmote.map(row => [row.upgradeId, row.baseId])),
});

/** Magisters' Terrace drops of either difficulty file under its zone row, which starts ticked, so its heroic epics stay in a default run. */
export const MAGISTERS_TERRACE_ZONE_ID = 4131;

/** A heroic five-man drop: heroic, and not Magisters' Terrace. The pool's heroic policy and the "Heroic dungeon" bucket both read it. */
export const isHeroicFiveManDrop = (drop: { zoneId: number; difficulty: DungeonDifficulty }): boolean =>
	drop.difficulty === DungeonDifficulty.DifficultyHeroic && drop.zoneId !== MAGISTERS_TERRACE_ZONE_ID;

/** A drop's boss: the npc's name, cut where upstream's generator overran its AtlasLoot key (ticket 680). */
const bossOf = (db: SourceDb, npcId: number): string | undefined => {
	const name = db.getNpc(npcId)?.name;
	return name === undefined ? undefined : (overrunNpcKey(name) ?? name);
};

const withBoss = <S extends object>(source: S, boss: string | undefined): S & { boss?: string } => (boss === undefined ? source : { ...source, boss });

/** One db.json source entry as the tab's source, or undefined when wowsims gives it no fact the tab names. */
function sourceOfEntry(entry: UIItem['sources'][number], db: SourceDb): ItemSource | undefined {
	const { source } = entry;
	switch (source.oneofKind) {
		case 'drop': {
			const { zoneId, npcId, difficulty } = source.drop;
			const zone = db.getZone(zoneId)?.name;
			if (zone === undefined) return undefined;
			if (isHeroicFiveManDrop(source.drop)) return { kind: 'heroic', dungeon: zone };
			// Only a Magisters' Terrace drop is heroic here: it keeps its zone row and is marked heroic.
			const heroic = difficulty === DungeonDifficulty.DifficultyHeroic;
			return withBoss({ kind: 'raid' as const, zone, ...(heroic ? { heroic: true } : {}) }, bossOf(db, npcId));
		}
		case 'crafted': {
			const profession = professionNames.get(source.crafted.profession);
			return profession === undefined ? undefined : { kind: 'crafted', profession };
		}
		case 'rep':
			return { kind: 'rep', faction: REP_FACTION_NAMES[source.rep.repFactionId], standing: REP_LEVEL_NAMES[source.rep.repLevel] };
		default:
			return undefined;
	}
}

/** A Sunmote upgrade's source: the base item's first normal drop, with the base item as the token. */
function sunmoteSource(baseId: number, db: SourceDb): ItemSource | undefined {
	const base = db.getItemById(baseId);
	if (!base) return undefined;
	const drop = base.sources.map(entry => sourceOfEntry(entry, db)).find(s => s?.kind === 'raid');
	if (drop?.kind !== 'raid') return undefined;
	return withBoss({ kind: 'token' as const, zone: drop.zone, token: `Sunmote + ${base.name}` }, drop.boss);
}

/**
 * Every source of `item`: its db.json drops, crafts and reputation vendors in db.json's order, then its tier token or
 * Sunmote exchange, then PvP for an arena piece; `[{kind: 'unknown'}]` when wowsims states none. A heroic drop outside
 * Magisters' Terrace is a `heroic` source, which files under the "Heroic dungeon" bucket and names no zone.
 */
export function sourcesOf(item: UIItem, db: SourceDb, exchange: ExchangeIndex): ItemSource[] {
	const found: ItemSource[] = [];
	for (const entry of item.sources) {
		const source = sourceOfEntry(entry, db);
		if (source) found.push(source);
	}
	const token = exchange.tokenByPiece.get(item.id);
	if (token) found.push({ kind: 'token', zone: token.zone, boss: token.boss, token: token.tokenName, tokenId: token.tokenId });
	const baseId = exchange.baseByUpgrade.get(item.id);
	const sunmote = baseId === undefined ? undefined : sunmoteSource(baseId, db);
	if (sunmote) found.push(sunmote);
	if (isPVPItem(item)) found.push({ kind: 'pvp', via: 'arena' });
	const seen = new Set<string>();
	const unique = found.filter(source => {
		const key = JSON.stringify(source);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return unique.length > 0 ? unique : [{ kind: 'unknown' }];
}
