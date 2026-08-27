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
 */

import { Database } from '../../../../proto_utils/database.js';
import { EquipmentSpec } from '../../../../proto/common.js';
import { SimDatabase } from '../../../../proto/db.js';
import type { SimItemSpec } from '../engine/slots.js';

/**
 * Builds the resolver `rankUpgrades` calls for every composed request
 * (`Deps.simDatabaseFor`). Returns protojson, matching the engine's opaque
 * `Readonly<Record<string, unknown>>` — the engine never inspects it.
 */
export function simDatabaseFor(equipment: readonly SimItemSpec[]): Readonly<Record<string, unknown>> | undefined {
	// Unguarded, like the engine's own items.ts: `getSync` throws if the
	// Database has not loaded, and by the time a ranking runs the page has
	// long since awaited it. A guard returning undefined here would silently
	// hand the sim a database-less request -- the exact bug ticket 212 fixes.
	const db = Database.getSync();

	const spec = EquipmentSpec.fromJson({ items: equipment.map(item => ({ ...item })) }, { ignoreUnknownFields: true });
	const gear = db.lookupEquipmentSpec(spec);
	return SimDatabase.toJson(gear.toDatabase(db)) as Readonly<Record<string, unknown>>;
}
