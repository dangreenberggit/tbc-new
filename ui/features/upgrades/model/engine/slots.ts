/**
 * 17-slot sim equipment order.
 *
 * PORTED from packages/core/src/slots.ts, `SIM_ORDER` half only. The 19→17
 * WCL mapping (`WCL_ORDER`, `mapWclGearToSim`) is not ported per plan §2.1 —
 * the page's `Gear` is already sim-native, so there is no WCL vocabulary to
 * translate on this surface. `slots-sim-order.generated.ts` was a generated
 * `as const` file gated by this repo's `pnpm codegen:json-types`; the fork
 * has no such generator, so the literal is hand-written here and kept in
 * sync with packages/core/src/slots-sim-order.generated.ts by inspection —
 * both ultimately trace to the same wowsims ItemSlot enum order.
 */

export const SIM_ORDER = [
  "head",
  "neck",
  "shoulder",
  "back",
  "chest",
  "wrist",
  "hands",
  "waist",
  "legs",
  "feet",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "mainhand",
  "offhand",
  "ranged",
] as const;

export type SimOrderName = (typeof SIM_ORDER)[number];

export type SimItemSpec = {
  id?: number;
  enchant?: number;
  gems: number[];
};
