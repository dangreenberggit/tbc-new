/**
 * The run-time pool over the fork's own db.json and each spec's wowsims
 * presets, for tests: what `buildPool` gives a live page, without a `Sim` or a
 * `Player`. The presets come from `model/pool_source.presets.fixture.json`,
 * whose `_comment` names the command that wrote it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Spec } from '@generated/proto/common';
import { UIDatabase, type UIItem } from '@generated/proto/ui';
import { MISSING_ITEM_EFFECTS } from '@sim/constants/missing_effects_auto_gen';
import { PlayerSpecs } from '@sim/player/specs';
import { canEquipItem } from '@sim/proto/items';

import type { PagePoolHost } from '../model/data/data';
import tierExchange from '../model/data/tier-exchange.json';
import type { PoolEntry } from '../model/engine/pool';
import type { SpecId } from '../model/engine/types';
import { HEROIC_FIVE_MAN, type HeroicFiveManPolicy, type PresetSet, selectPool } from '../model/pool_source';
import presetsFixture from '../model/pool_source.presets.fixture.json';
import { indexExchange, type SourceDb, sourcesOf, type TierExchange } from '../utils/item_sources';

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const TEST_DB = UIDatabase.fromJson(JSON.parse(readFileSync(path.join(FORK_ROOT, 'assets/database/db.json'), 'utf8')), { ignoreUnknownFields: true });

const byId = new Map(TEST_DB.items.map(item => [item.id, item]));
export const testItem = (id: number): UIItem | undefined => byId.get(id);
export const testItemPhase = (id: number): number | undefined => byId.get(id)?.phase;
export const TEST_MISSING_IDS: ReadonlySet<number> = new Set(MISSING_ITEM_EFFECTS.keys());

const zonesById = new Map(TEST_DB.zones.map(zone => [zone.id, zone]));
const npcsById = new Map(TEST_DB.npcs.map(npc => [npc.id, npc]));
/** The parts of `sim.db` the source facts read, over the test database. */
export const TEST_SOURCE_DB: SourceDb = {
	getZone: id => zonesById.get(id) ?? null,
	getNpc: id => npcsById.get(id) ?? null,
	getItemById: testItem,
};
// JSON values only: the file's shape is stated by `TierExchange`, never derived from the import (AGENTS.md, Types from JSON).
export const TEST_EXCHANGE = indexExchange(tierExchange as TierExchange);
export const testSourcesOf = (item: UIItem) => sourcesOf(item, TEST_SOURCE_DB, TEST_EXCHANGE);

// JSON values only: the fixture's shape is asserted here, never derived from the import (AGENTS.md, Types from JSON).
export const TEST_PRESETS = (presetsFixture as { specs: Record<string, PresetSet[]> }).specs;

export const PROTO_SPEC: Record<SpecId, Spec> = {
	balance: Spec.SpecBalanceDruid,
	feral: Spec.SpecFeralCatDruid,
	hunter: Spec.SpecHunter,
	mage: Spec.SpecMage,
	ret: Spec.SpecRetributionPaladin,
	shadow: Spec.SpecDpsPriest,
	rogue: Spec.SpecRogue,
	ele: Spec.SpecElementalShaman,
	enh: Spec.SpecEnhancementShaman,
	warlock: Spec.SpecWarlock,
	warrior: Spec.SpecDpsWarrior,
};

const canEquipFor = (spec: SpecId) => {
	const playerSpec = PlayerSpecs.fromProto(PROTO_SPEC[spec]);
	return (item: UIItem) => canEquipItem(item, playerSpec, undefined);
};

export const dbPoolFor = (spec: SpecId, phase: number, policy: HeroicFiveManPolicy = HEROIC_FIVE_MAN): PoolEntry[] =>
	selectPool(TEST_DB.items, canEquipFor(spec), TEST_PRESETS[spec]!, TEST_MISSING_IDS, phase, policy, testSourcesOf);

/** The page parts `poolFor` reads, over the test database and the spec's presets: a live page's pool, without a `Sim`. */
export const dbPoolHost = (spec: SpecId) =>
	({
		sim: { db: { getAllItems: () => TEST_DB.items, ...TEST_SOURCE_DB } },
		player: { getPlayerSpec: () => PlayerSpecs.fromProto(PROTO_SPEC[spec]) },
		individualConfig: {
			presets: {
				gear: TEST_PRESETS[spec]!.map(p => ({
					name: p.name,
					...(p.phase !== undefined ? { phase: p.phase } : {}),
					gear: { items: p.itemIds.map(id => ({ id })) },
				})),
			},
		},
	}) as unknown as PagePoolHost;
