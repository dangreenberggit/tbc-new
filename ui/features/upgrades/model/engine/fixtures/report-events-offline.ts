/**
 * Build RecordedGearSourceData from a raw WCL capture. A fixture loader, not
 * production code: it lets `RecordedSimRunner`/`RecordedGearSource` replay a
 * committed capture.
 */

import {
  characterFightKey,
  fightGearKey,
  type FightSummary,
  type LoggedGear,
  type RecordedGearSourceData,
} from "../seams/gear-source";
import { SIM_ORDER, type SimItemSpec } from "../slots";
import type { CharacterRef, SpecId } from "../types";

export type WclGearEntry = {
  id?: number | null;
  permanentEnchant?: number | null;
  gems?: Array<{ id?: number | null } | null> | null;
};

export type ReportEventsRawFixture = {
  report_code: string;
  fight: { id: number; name: string; kill?: boolean };
  actors: Array<{ id: number; name: string; subType?: string }>;
  combatant_info_events: Array<{
    sourceID: number;
    gear: WclGearEntry[];
    talents?: Array<{ id: number }>;
  }>;
};

export const REPORT_EVENTS_REF: CharacterRef = {
  region: "US",
  realm: "dreamscythe",
  name: "slamaltman",
};

/**
 * WCL's 19-slot gear order. The page's `Gear` is already sim-native; only a
 * raw WCL capture needs mapping to the 17-slot `SimItemSpec[]` that
 * production code consumes, so the mapping lives with the fixture loader.
 */
const WCL_ORDER = [
  "head",
  "neck",
  "shoulder",
  "SHIRT",
  "chest",
  "waist",
  "legs",
  "feet",
  "wrist",
  "hands",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "back",
  "mainhand",
  "offhand",
  "ranged",
  "TABARD",
] as const;

function mapWclGearToSim(wclGear: readonly WclGearEntry[]): SimItemSpec[] {
  if (wclGear.length !== WCL_ORDER.length) {
    throw new Error(
      `expected ${WCL_ORDER.length} WCL gear slots, got ${wclGear.length}`
    );
  }

  const bySlot = new Map<string, SimItemSpec>();
  for (let i = 0; i < WCL_ORDER.length; i++) {
    const name = WCL_ORDER[i]!;
    if (name === "SHIRT" || name === "TABARD") continue;
    bySlot.set(name, toItemSpec(wclGear[i]!));
  }

  return SIM_ORDER.map((name) => {
    const item = bySlot.get(name);
    if (!item) {
      throw new Error(`missing mapped slot ${name}`);
    }
    return item;
  });
}

function toItemSpec(slot: WclGearEntry): SimItemSpec {
  const id = slot.id ?? 0;
  if (!id) return { gems: [] };

  const gems = (slot.gems ?? [])
    .map((g) => g?.id)
    .filter((g): g is number => typeof g === "number" && g > 0);

  const out: SimItemSpec = { id, gems };
  const ench = slot.permanentEnchant;
  if (ench) out.enchant = ench;
  return out;
}

function talentPointsFrom(
  ev: { talents?: Array<{ id: number }> },
  character: CharacterRef
): LoggedGear["talentPointsByTree"] {
  const points = (ev.talents ?? []).map((t) => t.id);
  if (points.length !== 3) {
    throw new Error(
      `${character.name}'s CombatantInfo carries ${points.length} talent trees, ` +
        `expected 3 — the capture cannot classify a spec`
    );
  }
  return [points[0]!, points[1]!, points[2]!];
}

type OfflineRawFixture = {
  report_code: string;
  fight: { id: number; name: string };
  actors: Array<{ id: number; name: string; subType?: string }>;
  combatant_info_events: Array<{
    sourceID: number;
    gear: WclGearEntry[];
    talents?: Array<{ id: number }>;
  }>;
};

export function buildOfflineRecordings(
  raw: OfflineRawFixture,
  character: CharacterRef,
  spec: SpecId,
  route: FightSummary["route"],
  confidence: number,
  notFoundMessage: (character: CharacterRef, raw: OfflineRawFixture) => string,
  killedAt?: string
): RecordedGearSourceData {
  const actors = new Map(raw.actors.map((a) => [a.id, a]));
  const wanted = character.name.toLowerCase();
  let logged: LoggedGear | undefined;
  for (const ev of raw.combatant_info_events) {
    const actor = actors.get(ev.sourceID);
    if (actor?.name.toLowerCase() !== wanted) continue;
    const mapped = mapWclGearToSim(ev.gear);
    logged = {
      items: mapped.map((spec, i) => {
        const item: LoggedGear["items"][number] = {
          id: spec.id ?? 0,
          slot: SIM_ORDER[i]!,
          gems: spec.gems,
        };
        if (spec.enchant) item.enchant = spec.enchant;
        return item;
      }),
      talentPointsByTree: talentPointsFrom(ev, character),
      ...(actor.subType !== undefined ? { className: actor.subType } : {}),
      provenance: {
        reportCode: raw.report_code,
        fightId: raw.fight.id,
        sourceID: ev.sourceID,
      },
    };
    break;
  }
  if (!logged) {
    throw new Error(notFoundMessage(character, raw));
  }

  const summary: FightSummary = {
    reportCode: raw.report_code,
    fightId: raw.fight.id,
    encounterName: raw.fight.name,
    route,
    confidence,
    ...(killedAt ? { killedAt } : {}),
  };

  return {
    fights: new Map([[characterFightKey(character, spec), [summary]]]),
    gear: new Map([[fightGearKey(summary), logged]]),
  };
}
