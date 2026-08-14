/**
 * GearSource seam — hide the gear-reading transport behind findFights /
 * readGear.
 *
 * PORTED from packages/core/src/seams/gear-source.ts. `CachingGearSource`
 * and `RecordedGearSource` are unchanged; the WCL-facing doc comments (race
 * being "intentionally absent", the fight-list TTL note) describe the CLI's
 * transport and are kept for provenance even though this fork's real
 * `PlayerGearSource` (slice 3) reads the page instead of WCL — the seam
 * *interface* is what plan §2.1 asks to be ported, unchanged by which
 * adapter implements it.
 */

import type { CharacterRef, FightRef, SpecId } from "../types.js";
import type { Store } from "./store.js";

export type FightSummary = {
  reportCode: string;
  fightId: number;
  encounterName: string;
  killedAt?: string;
  route: "ranked" | "report-events";
  confidence: number;
  salvationUptime?: number;
};

export type LoggedItem = {
  id: number;
  slot: string;
  enchant?: number;
  gems?: number[];
};

export type LoggedGear = {
  items: LoggedItem[];
  talentPointsByTree: [number, number, number];
  className?: string;
  specIdHint?: number;
  provenance: {
    reportCode: string;
    fightId: number;
    sourceID: number;
  };
};

export interface GearSource {
  findFights(c: CharacterRef, spec: SpecId): Promise<FightSummary[]>;
  readGear(f: FightRef): Promise<LoggedGear>;
}

export type RecordedGearSourceData = {
  fights: ReadonlyMap<string, FightSummary[]>;
  gear: ReadonlyMap<string, LoggedGear>;
};

export function characterFightKey(c: CharacterRef, spec: SpecId): string {
  return `${c.region}|${c.realm.toLowerCase()}|${c.name.toLowerCase()}|${spec}`;
}

export function fightGearKey(f: FightRef): string {
  return `${f.reportCode}|${f.fightId}`;
}

export class CachingGearSource implements GearSource {
  constructor(
    private readonly inner: GearSource,
    private readonly store: Pick<Store, "get" | "put">,
    private readonly character: CharacterRef,
    private readonly spec: SpecId
  ) {}

  findFights(c: CharacterRef, spec: SpecId): Promise<FightSummary[]> {
    return this.inner.findFights(c, spec);
  }

  async readGear(f: FightRef): Promise<LoggedGear> {
    const key = gearCacheKey(f, this.character, this.spec);
    const cached = await this.store.get<LoggedGear>(key);
    if (cached) return cached;
    const logged = await this.inner.readGear(f);
    await this.store.put(key, logged);
    return logged;
  }
}

export function gearCacheKey(
  f: FightRef,
  c: CharacterRef,
  spec: SpecId
): string {
  return `gear:${fightGearKey(f)}|${characterFightKey(c, spec)}`;
}

export class RecordedGearSource implements GearSource {
  constructor(private readonly data: RecordedGearSourceData) {}

  async findFights(c: CharacterRef, spec: SpecId): Promise<FightSummary[]> {
    return this.data.fights.get(characterFightKey(c, spec)) ?? [];
  }

  async readGear(f: FightRef): Promise<LoggedGear> {
    const hit = this.data.gear.get(fightGearKey(f));
    if (!hit) {
      throw new Error(`no recording for fight ${fightGearKey(f)}`);
    }
    return hit;
  }
}
