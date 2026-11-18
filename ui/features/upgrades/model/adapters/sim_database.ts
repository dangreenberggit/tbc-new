/**
 * Per-request item rows for the WASM sim. `lib.wasm` is built without the
 * `with_db` tag, so its item registry is filled per request from
 * `player.database`; a candidate the character does not wear is in no database
 * the page built, and the sim panics on its id before the first iteration.
 *
 * The rows come from wowsims' own path: `Database.lookupEquipmentSpec`
 * resolves the equipment into a `Gear`, and `Gear.toDatabase(db)` builds the
 * `SimDatabase` the page attaches to every sim, with gems, enchants, random
 * suffixes and itemEffectRandPropPoints included. An item the Database cannot
 * resolve gets no row on purpose: the sim's panic is reported on that row,
 * where a fallback would give a wrong number.
 *
 * compose() replaces `player.database` wholesale, so two sets of rows from the
 * skeleton must be supplied again here:
 * - Item-swap gear. `enableItemSwap` (`sim/core/item_swaps.go`) resolves every
 *   swap entry at character construction, so a missing id panics the run.
 *   `Player.toDatabase` (`ui/sim/player/player.ts`) merges worn and swap gear
 *   without checking `getEnableItemSwap()`, and so does this; an empty swap
 *   set adds no rows.
 * - The player's `consumables` and `spellEffects`. `makeRaidSimRequest`
 *   (`ui/sim/sim.ts`) named the consumables and filled these rows when it built
 *   the skeleton. Go skips a named consumable that has no row, and a consumable
 *   whose effect row is missing is a nil dereference (`sim/core/consumes.go`).
 */

import { EquipmentSpec } from '@generated/proto/common';
import { SimDatabase } from '@generated/proto/db';
import type { Player } from '@sim/player/player';
import { Database } from '@sim/proto/database';

import type { RaidSimRequest } from '../engine/seams/sim-runner';
import type { SimItemSpec } from '../engine/slots';

/**
 * Builds the resolver `rankUpgrades` calls for every composed request
 * (`Deps.simDatabaseFor`). Returns protojson, matching the engine's opaque
 * `Readonly<Record<string, unknown>>` — the engine never inspects it.
 *
 * Closes over the page's `Player` for its item-swap rows and over the run's
 * skeleton for its consumable rows, because the engine hands the resolver only
 * the equipment array.
 */
export function simDatabaseResolverFor(
	player: Player<any>,
	skeleton: RaidSimRequest,
): (equipment: readonly SimItemSpec[]) => Readonly<Record<string, unknown>> | undefined {
	// The seam keeps the request opaque (`engine/seams/sim-runner.ts` header),
	// so the path to the player is typed here, and `fromJson`'s `JsonValue`
	// gets a `Record<string, never>` cast.
	const skeletonPlayer = (skeleton as { raid?: { parties?: Array<{ players?: Array<{ database?: unknown }> }> } }).raid?.parties?.[0]?.players?.[0];
	const skeletonDb = SimDatabase.fromJson((skeletonPlayer?.database ?? {}) as Record<string, never>, { ignoreUnknownFields: true });
	// A skeleton with no player database gives empty rows, which is what the
	// page itself sent.
	const pageRows = SimDatabase.create({ consumables: skeletonDb.consumables, spellEffects: skeletonDb.spellEffects });

	return equipment => {
		// Unguarded, like the engine's own items.ts: `getSync` throws if the
		// Database has not loaded, and by the time a ranking runs the page has
		// long since awaited it. A guard returning undefined would hand the sim a
		// request with no item rows.
		const db = Database.getSync();

		const spec = EquipmentSpec.fromJson({ items: equipment.map(item => ({ ...item })) }, { ignoreUnknownFields: true });
		const gear = db.lookupEquipmentSpec(spec);
		const swap = player.itemSwapSettings.getGear().toDatabase(db);
		return SimDatabase.toJson(Database.mergeSimDatabases(Database.mergeSimDatabases(gear.toDatabase(db), swap), pageRows)) as Readonly<
			Record<string, unknown>
		>;
	};
}
