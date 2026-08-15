/**
 * WCL gear-only import modal (plan §6, slice 5). Two steps in one modal:
 * paste a report URL, pick the roster member, apply their gear via
 * `player.setGear` — everything else on the page stays untouched (bound by
 * E-W4, see `docs/plans/wowsims-tab/experiments/e-w4-method.md` in the outer
 * repo). Placement follows the tab's own idiom (a button inside the
 * Upgrades tab, not a header import link) because this import is scoped to
 * "gear for ranking", not a general-purpose settings import — the header
 * importers (JSON/60U/WoWHead/Addon) all apply race/talents/professions
 * too, which this deliberately does not.
 */

import { ref } from "tsx-vanilla";

import { IndividualSimUI } from "../../../individual_sim_ui.js";
import { TypedEvent } from "../../../typed_event.js";
import { BaseModal } from "../../base_modal.js";
import Toast from "../../toast.js";
import {
  HttpWclClient,
  parseReportUrl,
  resolveGearFromRoster,
  WclImportError,
  type WclFightSummary,
  type WclRosterEntry,
} from "./adapters/wcl_gear_import.js";

/**
 * Reads the gitignored local credentials file lazily so a missing file
 * (a fresh checkout that never copied the `.example.ts` template) fails
 * with a clear message instead of a bundler error, and so an empty client
 * id (this worker's own environment — see the slice 5 handoff) reports
 * plainly rather than attempting a doomed fetch.
 */
async function loadWclCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const missingMessage =
    "No local WCL credentials found. Copy adapters/local.wcl-credentials.example.ts to adapters/local.wcl-credentials.ts and fill in your own client id/secret.";
  try {
    const mod = await import("./adapters/local.wcl-credentials.js");
    if (!mod.WCL_CLIENT_ID || !mod.WCL_CLIENT_SECRET) {
      // The file exists (a fresh checkout that copied the template, or —
      // this worker's own environment — no credentials were available) but
      // its values are still blank. Report the same friendly message as a
      // missing file rather than letting an empty Basic-auth header reach
      // WCL's /oauth/token and fail with an opaque API error.
      throw new WclImportError(missingMessage);
    }
    return { clientId: mod.WCL_CLIENT_ID, clientSecret: mod.WCL_CLIENT_SECRET };
  } catch (err) {
    if (err instanceof WclImportError) throw err;
    throw new WclImportError(missingMessage);
  }
}

type Step =
  | { kind: "url" }
  | { kind: "fight-pick"; reportCode: string; fights: WclFightSummary[] }
  | { kind: "roster-pick"; reportCode: string; fightId: number; roster: WclRosterEntry[] }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string };

export class WclGearImportModal extends BaseModal {
  private readonly simUI: IndividualSimUI<any>;
  private readonly bodyContentElem: HTMLElement;
  private step: Step = { kind: "url" };

  constructor(parent: HTMLElement, simUI: IndividualSimUI<any>) {
    super(parent, "wcl-gear-import-modal", { title: "Import gear from a Warcraft Logs report", footer: false });
    this.simUI = simUI;

    const bodyRef = ref<HTMLDivElement>();
    this.body.appendChild(<div ref={bodyRef} className="wcl-gear-import-body" />);
    this.bodyContentElem = bodyRef.value!;

    this.render();
  }

  private setStep(step: Step) {
    this.step = step;
    this.render();
  }

  private render() {
    this.bodyContentElem.replaceChildren(this.stepContent());
  }

  private stepContent(): Node {
    switch (this.step.kind) {
      case "url":
        return this.urlStepContent();
      case "fight-pick":
        return this.fightPickContent(this.step.reportCode, this.step.fights);
      case "roster-pick":
        return this.rosterPickContent(this.step.reportCode, this.step.fightId, this.step.roster);
      case "loading":
        return <div className="text-muted">{this.step.message}</div>;
      case "error":
        return (
          <div>
            <div className="text-danger mb-2">{this.step.message}</div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onclick={() => this.setStep({ kind: "url" })}>
              Start over
            </button>
          </div>
        );
    }
  }

  private urlStepContent(): Node {
    const urlInputRef = ref<HTMLInputElement>();
    return (
      <div>
        <p className="text-muted">
          Paste a report link, e.g. https://classic.warcraftlogs.com/reports/AbCd1234#fight=5. Only the 17 equipment slots are
          applied — talents, rotation, buffs, and consumes on this page stay exactly as you set them.
        </p>
        <div className="d-flex gap-2">
          <input
            ref={urlInputRef}
            type="text"
            className="form-control"
            placeholder="classic.warcraftlogs.com/reports/..."
          />
          <button
            type="button"
            className="btn btn-primary"
            onclick={() => this.onUrlSubmit(urlInputRef.value!.value)}>
            Next
          </button>
        </div>
      </div>
    );
  }

  private async onUrlSubmit(url: string) {
    try {
      const { reportCode, fightId } = parseReportUrl(url);
      this.setStep({ kind: "loading", message: "Fetching report…" });
      const { clientId, clientSecret } = await loadWclCredentials();
      const client = new HttpWclClient(clientId, clientSecret);

      if (fightId === "unspecified") {
        const fights = await client.listFights(reportCode);
        if (fights.length === 0) throw new WclImportError(`Report "${reportCode}" has no kills to pick from`);
        this.setStep({ kind: "fight-pick", reportCode, fights });
        return;
      }

      await this.loadRoster(client, reportCode, fightId);
    } catch (err) {
      this.setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private fightPickContent(reportCode: string, fights: WclFightSummary[]): Node {
    return (
      <div>
        <p className="text-muted">No fight ID in the link — pick a fight:</p>
        <ul className="list-group">
          {fights.map((f) => (
            <li className="list-group-item list-group-item-action" attributes={{ role: 'button' }}>
              <a
                href="#"
                onclick={(e: Event) => {
                  e.preventDefault();
                  this.onFightPick(reportCode, f.id);
                }}>
                {f.name} (#{f.id})
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  private async onFightPick(reportCode: string, fightId: number) {
    try {
      this.setStep({ kind: "loading", message: "Fetching roster…" });
      const { clientId, clientSecret } = await loadWclCredentials();
      const client = new HttpWclClient(clientId, clientSecret);
      await this.loadRoster(client, reportCode, fightId);
    } catch (err) {
      this.setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadRoster(client: HttpWclClient, reportCode: string, fightId: number) {
    const roster = await client.readRoster({ reportCode, fightId });
    if (roster.length === 0) throw new WclImportError(`No players found in fight ${fightId}`);
    this.setStep({ kind: "roster-pick", reportCode, fightId, roster });
  }

  private rosterPickContent(_reportCode: string, _fightId: number, roster: WclRosterEntry[]): Node {
    return (
      <div>
        <p className="text-muted">Pick your character:</p>
        <ul className="list-group">
          {roster.map((entry) => (
            <li className="list-group-item list-group-item-action" attributes={{ role: 'button' }}>
              <a
                href="#"
                onclick={(e: Event) => {
                  e.preventDefault();
                  this.onRosterPick(entry);
                }}>
                {entry.name} — {entry.icon || entry.className}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  private async onRosterPick(entry: WclRosterEntry) {
    try {
      this.setStep({ kind: "loading", message: `Applying ${entry.name}'s gear…` });
      const { equipmentSpec, unresolvedItemIds } = await resolveGearFromRoster(entry);

      const gear = this.simUI.sim.db.lookupEquipmentSpec(equipmentSpec);
      const eventID = TypedEvent.nextEventID();
      // The single-purpose call E-W4 verified: touches player.equipment
      // only. Do not switch this to `player.fromProto(..., [Gear])` — see
      // this module's top comment and the method doc it cites.
      this.simUI.player.setGear(eventID, gear);

      this.close();

      if (unresolvedItemIds.length === 0) {
        new Toast({ variant: "success", body: `Applied ${entry.name}'s gear from the log.` });
      } else {
        new Toast({
          variant: "info",
          body: `Applied ${entry.name}'s gear, but these item IDs were not found in the sim database: ${unresolvedItemIds.join(", ")}`,
        });
      }
    } catch (err) {
      this.setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
}
