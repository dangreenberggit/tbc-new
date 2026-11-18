/**
 * Per-request item rows for the WASM sim. `lib.wasm` is built without `with_db`, so
 * the sim panics on an item id missing from `player.database`. An item the Database
 * cannot resolve gets no row on purpose: the panic is reported on that row, where a
 * fallback would give a wrong number. compose() replaces `player.database`
 * wholesale, so the skeleton's consumable and spell-effect rows and the item-swap
 * gear (even with swap off, as `Player.toDatabase` does) go back in; the sim skips
 * or panics without them (`sim/core/item_swaps.go`, `sim/core/consumes.go`).
 */

import { EquipmentSpec } from '@generated/proto/common';
import { SimDatabase } from '@generated/proto/db';
import type { Player } from '@sim/player/player';
import { Database } from '@sim/proto/database';

import type { RaidSimRequest } from '../engine/seams/sim-runner';
import type { SimItemSpec } from '../engine/slots';

/**
 * `rankUpgrades` calls this for every request it builds (`Deps.simDatabaseFor`) and
 * passes only the equipment, so it holds on to the page's `Player` and `skeleton`.
 */
export function simDatabaseResolverFor(
	player: Player<any>,
	skeleton: RaidSimRequest,
): (equipment: readonly SimItemSpec[]) => Readonly<Record<string, unknown>> | undefined {
	// The engine treats the request as opaque, so the path to the player is typed here.
	const skeletonPlayer = (skeleton as { raid?: { parties?: Array<{ players?: Array<{ database?: unknown }> }> } }).raid?.parties?.[0]?.players?.[0];
	const skeletonDb = SimDatabase.fromJson((skeletonPlayer?.database ?? {}) as Record<string, never>, { ignoreUnknownFields: true });
	// A skeleton with no player database gives empty rows, which is what the
	// page itself sent.
	const pageRows = SimDatabase.create({ consumables: skeletonDb.consumables, spellEffects: skeletonDb.spellEffects });

	return equipment => {
		// Unguarded, like the engine's items.ts: the page has awaited the Database long
		// before a ranking runs, and a guard returning undefined would send no item rows.
		const db = Database.getSync();

		const spec = EquipmentSpec.fromJson({ items: equipment.map(item => ({ ...item })) }, { ignoreUnknownFields: true });
		const gear = db.lookupEquipmentSpec(spec);
		const swap = player.itemSwapSettings.getGear().toDatabase(db);
		return SimDatabase.toJson(Database.mergeSimDatabases(Database.mergeSimDatabases(gear.toDatabase(db), swap), pageRows)) as Readonly<
			Record<string, unknown>
		>;
	};
}
