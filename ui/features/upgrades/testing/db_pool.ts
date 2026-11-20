/**
 * The run-time pool over db.json and each spec's presets, for tests: what `buildPool`
 * gives a live page, without a `Sim` or a `Player`. The presets come from
 * `model/pool_source.presets.fixture.json`: each DPS spec's preset gear sets (name, declared phase,
 * `group` where the preset has one, item ids) as its config lists them. After an upstream preset
 * change, copy each changed set from the spec's `presets.ts` and the `gear_sets/` file it imports,
 * then re-pin the pool sizes as `model/pool_source.test.ts` says.
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
import { HEROIC_FIVE_MAN_POLICY, type HeroicFiveManPolicy, type PresetGearSet, selectPool } from '../model/pool_source';
import presetsFixture from '../model/pool_source.presets.fixture.json';
import { specIdFor } from '../model/run';
import { indexExchange, itemSourcesFromDb, type SourceDb, type TierExchange } from '../utils/item_sources';

const FORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const TEST_DB = UIDatabase.fromJson(JSON.parse(readFileSync(path.join(FORK_ROOT, 'assets/database/db.json'), 'utf8')), { ignoreUnknownFields: true });

const byId = new Map(TEST_DB.items.map(item => [item.id, item]));
export const testItem = (id: number): UIItem | undefined => byId.get(id);
export const testItemPhase = (id: number): number | undefined => byId.get(id)?.phase;
export const TEST_MISSING_IDS: ReadonlySet<number> = new Set(MISSING_ITEM_EFFECTS.keys());

const zonesById = new Map(TEST_DB.zones.map(zone => [zone.id, zone]));
const npcsById = new Map(TEST_DB.npcs.map(npc => [npc.id, npc]));
export const TEST_SOURCE_DB: SourceDb = {
	getZone: id => zonesById.get(id) ?? null,
	getNpc: id => npcsById.get(id) ?? null,
	getItemById: testItem,
};
// JSON values only: the file's shape is stated by `TierExchange`, never derived from the import.
export const TEST_EXCHANGE = indexExchange(tierExchange as TierExchange);
export const testSourcesOf = (item: UIItem) => itemSourcesFromDb(item, TEST_SOURCE_DB, TEST_EXCHANGE);

// JSON values only: the fixture's shape is asserted here, never derived from the import.
export const TEST_PRESETS = (presetsFixture as { specs: Record<string, PresetGearSet[]> }).specs;

/** Built by inverting `specIdFor` from `run.ts`, so the two cannot drift; `pool_source.test.ts` checks it covers every preset spec. */
export const PROTO_SPEC_BY_SPEC_ID = Object.fromEntries(
	Object.values(Spec)
		.filter((spec): spec is Spec => typeof spec === 'number')
		.flatMap(spec => {
			const specId = specIdFor(spec);
			return specId ? [[specId, spec] as const] : [];
		}),
) as Record<SpecId, Spec>;

const canEquipFor = (spec: SpecId) => {
	const playerSpec = PlayerSpecs.fromProto(PROTO_SPEC_BY_SPEC_ID[spec]);
	return (item: UIItem) => canEquipItem(item, playerSpec, undefined);
};

export const dbPoolFor = (spec: SpecId, phase: number, policy: HeroicFiveManPolicy = HEROIC_FIVE_MAN_POLICY): PoolEntry[] =>
	selectPool(TEST_DB.items, canEquipFor(spec), TEST_PRESETS[spec]!, TEST_MISSING_IDS, phase, policy, testSourcesOf);

/** The parts of the page that `poolFor` reads, backed by the test database and the spec's presets, so tests get a live page's pool without a `Sim`. */
export const dbPoolHost = (spec: SpecId) =>
	({
		sim: { db: { getAllItems: () => TEST_DB.items, ...TEST_SOURCE_DB } },
		player: { getPlayerSpec: () => PlayerSpecs.fromProto(PROTO_SPEC_BY_SPEC_ID[spec]), getGear: () => ({ getEquippedItems: () => [] }) },
		individualConfig: {
			presets: {
				gear: TEST_PRESETS[spec]!.map(p => ({
					name: p.name,
					...(p.phase !== undefined ? { phase: p.phase } : {}),
					...(p.group !== undefined ? { group: p.group } : {}),
					gear: { items: p.itemIds.map(id => ({ id })) },
				})),
			},
		},
	}) as unknown as PagePoolHost;
