/**
 * Compose stage — patch a golden RaidSimRequest skeleton with the player's
 * name / race / equipment.
 *
 * PORTED from packages/core/src/compose.ts, unchanged. Operates on the same
 * protojson-shaped `RaidSimRequest` (seams/sim-runner.ts) as packages/core;
 * see that seam file's doc comment for why the fork's typed proto interface
 * is not used directly here.
 */

import type { RaidSimRequest } from "./seams/sim-runner.js";
import type { SimItemSpec } from "./slots.js";
import type { Race } from "./types.js";

export type ComposePlayer = {
  name: string;
  race: Race;
  equipment: readonly SimItemSpec[];
  /**
   * Per-request item rows for the WASM sim, which is built without
   * `with_db` and so starts with an empty registry (ticket 212). Opaque
   * protojson, like RaidSimRequest — the shape belongs to the sim's
   * SimDatabase, and deriving a type for it here would buy nothing.
   * Omitted by CLI callers, whose binary is built with_db.
   */
  database?: Readonly<Record<string, unknown>>;
};

export function compose(
  skeleton: RaidSimRequest,
  player: ComposePlayer
): RaidSimRequest {
  const req = structuredClone(skeleton) as Record<string, unknown>;
  delete req.simOptions;
  delete req.requestId;

  const raid = req.raid as {
    parties: Array<{ players: Array<Record<string, unknown>> }>;
  };
  const slot = raid.parties[0]?.players[0];
  if (!slot) {
    throw new Error("skeleton missing raid.parties[0].players[0]");
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
