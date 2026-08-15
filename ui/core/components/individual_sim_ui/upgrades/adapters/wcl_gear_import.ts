/**
 * WCL gear-only import (plan §6, slice 5, decision D6): read a Warcraft Logs
 * report/fight and apply one roster member's gear to the current player via
 * `player.setGear` — nothing else on the page changes.
 *
 * Fetch code (OAuth2 client-credentials flow, GraphQL query shape, report-URL
 * regex) is adapted from `ui/raid/components/importers/raid_wcl_importer.tsx`
 * (the in-repo reference plan §6 names) — same endpoints, same query idiom,
 * but reading one player's `data.gear` into an `EquipmentSpec` instead of
 * building a whole raid. Credentials here are the user's own personal WCL
 * dev client id/secret, read from a gitignored local config
 * (`local.wcl-credentials.ts` — see that file's own comment) — never the
 * hardcoded wowsims credential embedded in `raid_wcl_importer.tsx`, and never
 * committed.
 *
 * DB-validation idiom (`Database.loadLeftoversIfNecessary` +
 * `lookupItemSpec`) copied from `bulk_gear_json_importer.tsx`, per the
 * E-W4 method doc's "application call under test" section — items outside
 * the already-loaded database (uncommon world drops, etc.) are resolved
 * before `lookupEquipmentSpec` runs, and any that still fail to resolve are
 * reported rather than silently dropped from the equipped result.
 *
 * The application call is `player.setGear` (bound by E-W4, method doc
 * "The application call under test"): the category-filtered alternative,
 * `player.fromProto(eventID, proto, [SimSettingCategories.Gear])`, would
 * also rewrite `bonusStats`/`enableItemSwap`/`itemSwap` — page settings a
 * WCL log knows nothing about. `setGear` touches only `player.equipment`.
 */

import { EquipmentSpec, ItemSpec } from "../../../../proto/common.js";
import { Database } from "../../../../proto_utils/database.js";

/** One report/fight identified by a pasted WCL report URL. */
export type WclFightRef = {
  reportCode: string;
  fightId: number;
};

/** A single roster member's gear, as returned by WCL's report table. */
export type WclRosterEntry = {
  id: number;
  name: string;
  /** WCL's own `icon` field, e.g. "Paladin-Retribution" — display only, no spec inference performed here (gear-only import needs no spec match). */
  icon: string;
  className: string;
  gear: WclGearItem[];
};

export type WclGearItem = {
  id: number;
  permanentEnchant?: number;
  gems?: { id: number }[];
};

export class WclImportError extends Error {}

/**
 * Parses a pasted WCL report link, e.g.
 * "classic.warcraftlogs.com/reports/AbCd1234#fight=5" or "...#fight=last".
 * Mirrors `raid_wcl_importer.tsx`'s `parseURL` regex; unlike that importer,
 * a missing fight ID triggers a `MISSING_FIGHT_ID` marker (`fightId: -1`)
 * rather than silently picking the first fight — the caller resolves it via
 * `listFights`, letting the picker UI show real fight names.
 */
export function parseReportUrl(url: string): { reportCode: string; fightId: number | "unspecified" } {
  const match = url.match(/classic\.warcraftlogs\.com\/reports\/([a-zA-Z0-9:]+)\/?(#.*fight=((\d+)|(last)))?/);
  if (!match) {
    throw new WclImportError(
      `Invalid WCL URL "${url}", must look like "classic.warcraftlogs.com/reports/XXXX#fight=N"`,
    );
  }
  const reportCode = match[1]!;
  if (match[3] === "last") return { reportCode, fightId: "unspecified" }; // resolved against listFights() by the caller
  if (match[3]) return { reportCode, fightId: Number(match[4]) };
  return { reportCode, fightId: "unspecified" };
}

export type WclFightSummary = { id: number; name: string };

export interface WclClient {
  listFights(reportCode: string): Promise<WclFightSummary[]>;
  readRoster(fight: WclFightRef): Promise<WclRosterEntry[]>;
}

/** Real WCL API v2 client, browser-direct (same auth shape as `raid_wcl_importer.tsx`, different credentials — see this file's top comment). */
export class HttpWclClient implements WclClient {
  private token = "";

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async bearerToken(): Promise<string> {
    if (this.token === "") {
      const response = await fetch("https://classic.warcraftlogs.com/oauth/token", {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${this.clientId}:${this.clientSecret}`),
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });
      const json = await response.json();
      if (!json.access_token) {
        throw new WclImportError("WCL auth failed — check the local client id/secret");
      }
      this.token = json.access_token;
    }
    return this.token;
  }

  private async query(query: string): Promise<any> {
    const token = await this.bearerToken();
    const res = await fetch(encodeURI(`https://classic.warcraftlogs.com/api/v2/client?query=${query}`), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const result = await res.json();
    if (result?.errors?.length) {
      const errorStr = result.errors.map((e: any) => e.message).join("\n");
      throw new WclImportError(`WCL GraphQL error: ${errorStr}`);
    }
    return result;
  }

  async listFights(reportCode: string): Promise<WclFightSummary[]> {
    const data = await this.query(`{
      reportData {
        report(code: "${reportCode}") {
          fights(killType: Kills, translate: true) { id, name }
        }
      }
    }`);
    const fights = data?.data?.reportData?.report?.fights;
    if (!fights) throw new WclImportError(`Report "${reportCode}" not found or has no fights`);
    return fights as WclFightSummary[];
  }

  async readRoster(fight: WclFightRef): Promise<WclRosterEntry[]> {
    const data = await this.query(`{
      reportData {
        report(code: "${fight.reportCode}") {
          playerDetails: table(fightIDs: [${fight.fightId}], dataType: Casts, killType: All, viewBy: Default)
        }
      }
    }`);
    const entries = data?.data?.reportData?.report?.playerDetails?.data?.entries;
    if (!entries) throw new WclImportError(`No player data for fight ${fight.fightId} in report "${fight.reportCode}"`);
    return (entries as any[]).map((p) => ({
      id: p.id,
      name: p.name,
      icon: p.icon,
      className: p.type,
      gear: (p.gear ?? []) as WclGearItem[],
    }));
  }
}

/**
 * Builds an `EquipmentSpec` proto from one roster entry's `gear`, resolves
 * it against the sim's item database (loading any leftover-DB items first,
 * `bulk_gear_json_importer.tsx`'s idiom), and reports which item ids failed
 * to resolve rather than silently dropping them.
 */
export async function resolveGearFromRoster(entry: WclRosterEntry): Promise<{
  equipmentSpec: EquipmentSpec;
  unresolvedItemIds: number[];
}> {
  const equipmentSpec = EquipmentSpec.create({
    items: entry.gear.map((g) =>
      ItemSpec.create({
        id: g.id,
        enchant: g.permanentEnchant,
        gems: g.gems ? g.gems.map((gem) => gem.id) : [],
      }),
    ),
  });

  const db = await Database.loadLeftoversIfNecessary(equipmentSpec);
  const unresolvedItemIds = equipmentSpec.items.filter((spec) => spec.id > 0 && !db.lookupItemSpec(spec)).map((spec) => spec.id);

  return { equipmentSpec, unresolvedItemIds };
}
