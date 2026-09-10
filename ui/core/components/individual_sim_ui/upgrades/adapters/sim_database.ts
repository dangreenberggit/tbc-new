/**
 * Per-request item rows for the WASM sim (ticket 212).
 *
 * `lib.wasm` is built without the `with_db` tag and with `all_items.go`
 * filtered out, so its item registry starts empty and is filled per request
 * from `player.database`. `wowsimcli` IS built `with_db`, which is why no CLI
 * run ever reproduced the browser's panic: a candidate item the character
 * does not wear appears in no database the page ever built, and environment
 * construction dies on its id before a single iteration runs.
 *
 * This is upstream's own path, not a reimplementation:
 * `Database.lookupEquipmentSpec` resolves an EquipmentSpec into a `Gear`, and
 * `Gear.toDatabase(db)` produces the `SimDatabase` upstream itself attaches
 * beside the equipment on every sim (`ui/core/sim.ts` — `toProto` /
 * `makeRaidSimRequest`). Going through it means gems, enchants, random
 * suffixes and itemEffectRandPropPoints are all carried exactly as a normal
 * page sim carries them.
 *
 * An item the Database cannot resolve produces no row, and the sim then
 * panics on that id — deliberately. A silent fallback would turn a data gap
 * into a wrong number; the per-row disclosure (ticket 156 slice A) surfaces
 * the panic instead.
 *
 * Item-swap gear is merged in beside the composed equipment (ticket 362).
 * The character's swap set is not inert: `enableItemSwap`
 * (`sim/core/item_swaps.go`) resolves every swap entry at character
 * construction, before a single iteration runs, so an id it cannot find
 * panics the run — which is what the enhancement page's shipped default swap
 * did. The skeleton the tab captures already carries those rows in
 * `player.database`, but compose() replaces that field wholesale with this
 * resolver's result, so the rows have to be re-supplied here or they are
 * lost. Merging them unconditionally, worn-then-swap, is upstream's own
 * invariant: `Player.toDatabase` is
 * `mergeSimDatabases(gear.toDatabase(db), itemSwapSettings.getGear().toDatabase(db))`
 * (`ui/core/player.tsx`), which likewise does not consult
 * `getEnableItemSwap()` — an empty swap set contributes no rows, so the
 * unconditional merge costs a disabled page nothing.
 */

import { Database } from '../../../../proto_utils/database.js';
import { EquipmentSpec } from '../../../../proto/common.js';
import { SimDatabase } from '../../../../proto/db.js';
import type { Player } from '../../../../player.js';
import type { SimItemSpec } from '../engine/slots.js';

/**
 * Builds the resolver `rankUpgrades` calls for every composed request
 * (`Deps.simDatabaseFor`). Returns protojson, matching the engine's opaque
 * `Readonly<Record<string, unknown>>` — the engine never inspects it.
 *
 * Closes over the page's `Player` so every request carries that player's
 * item-swap rows. A factory rather than a bare function because the engine
 * hands the resolver only the equipment array, and widening that signature
 * would mean editing a ported engine file (ticket 362).
 */
export function simDatabaseResolverFor(player: Player<any>): (equipment: readonly SimItemSpec[]) => Readonly<Record<string, unknown>> | undefined {
	return equipment => {
		// Unguarded, like the engine's own items.ts: `getSync` throws if the
		// Database has not loaded, and by the time a ranking runs the page has
		// long since awaited it. A guard returning undefined here would silently
		// hand the sim a database-less request -- the exact bug ticket 212 fixes.
		const db = Database.getSync();

		const spec = EquipmentSpec.fromJson({ items: equipment.map(item => ({ ...item })) }, { ignoreUnknownFields: true });
		const gear = db.lookupEquipmentSpec(spec);
		const swap = player.itemSwapSettings.getGear().toDatabase(db);
		return SimDatabase.toJson(Database.mergeSimDatabases(gear.toDatabase(db), swap)) as Readonly<Record<string, unknown>>;
	};
}
