/**
 * Fills a template RaidSimRequest (`skeleton`) with the player's name, race and
 * equipment, in protojson form (see seams/sim-runner.ts).
 */

import type { RaidSimRequest } from './seams/sim-runner';
import type { SimItemSpec } from './slots';
import type { Race } from './types';

export type ComposePlayer = {
	name: string;
	race: Race;
	equipment: readonly SimItemSpec[];
	/**
	 * Per-request item rows (an opaque protojson SimDatabase) for the WASM sim, which is
	 * built without `with_db` and starts empty. CLI callers, built with_db, omit it.
	 */
	database?: Readonly<Record<string, unknown>>;
};

export function compose(skeleton: RaidSimRequest, player: ComposePlayer): RaidSimRequest {
	const req = structuredClone(skeleton) as Record<string, unknown>;
	delete req.simOptions;
	delete req.requestId;

	const raid = req.raid as {
		parties: Array<{ players: Array<Record<string, unknown>> }>;
	};
	const slot = raid.parties[0]?.players[0];
	if (!slot) {
		throw new Error('skeleton missing raid.parties[0].players[0]');
	}

	slot.name = player.name;
	slot.race = player.race;
	slot.equipment = { items: player.equipment.map(toProtoItem) };
	if (player.database) slot.database = player.database;

	return req;
}

function toProtoItem(spec: SimItemSpec): Record<string, unknown> {
	if (!spec.id) return {};
	const out: Record<string, unknown> = { id: spec.id };
	if (spec.enchant) out.enchant = spec.enchant;
	if (spec.gems.length > 0) out.gems = [...spec.gems];
	return out;
}
