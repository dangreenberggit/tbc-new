import { describe, expect, it } from "vitest";

import {
  CAP_PROFILE_BY_SPEC,
  capProfileFor,
  hitCapBudgetFrom,
  PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
  SPELL_HIT_RATING_PER_HIT_PERCENT,
} from "./cap-profile";
import { Stat } from "./stats";
import type { SpecId } from "./types";

/** A pseudo-stat array with slots 12 (melee hit %) and 13 (spell hit %) set. */
function pseudoStats(hit: { melee?: number; spell?: number }): number[] {
  const out = new Array<number>(25).fill(0);
  out[12] = hit.melee ?? 0;
  out[13] = hit.spell ?? 0;
  return out;
}

function request(
  faerieFire: string | number | undefined,
  levels: readonly number[] = [73]
) {
  return {
    raid: { debuffs: faerieFire === undefined ? {} : { faerieFire } },
    encounter: { targets: levels.map((level) => ({ level })) },
  };
}

describe("meta repair hit policy per spec (746)", () => {
  it("gives the note to rogue, enh, warrior, hunter, balance and ele and a budget to every other spec", () => {
    const specs = Object.keys(CAP_PROFILE_BY_SPEC) as SpecId[];
    const byKind = (kind: string) =>
      specs.filter((s) => CAP_PROFILE_BY_SPEC[s].repair.kind === kind).sort();
    expect(byKind("fullWeight")).toEqual([
      "balance",
      "ele",
      "enh",
      "hunter",
      "rogue",
      "warrior",
    ]);
    expect(byKind("budget")).toEqual([
      "feral",
      "mage",
      "ret",
      "shadow",
      "warlock",
    ]);
  });

  it("charges a melee spec's hit against 9% minus Improved Faerie Fire, read from slot 12", () => {
    const budget = hitCapBudgetFrom(
      capProfileFor("ret"),
      request("TristateEffectImproved"),
      pseudoStats({ melee: 7, spell: 1 })
    );
    expect(budget?.stat).toBe(Stat.StatMeleeHitRating);
    expect(budget?.remaining).toBeCloseTo(
      (9 - 3 - 7) * PHYSICAL_HIT_RATING_PER_HIT_PERCENT,
      9
    );
  });

  it("charges a caster's hit against 16% read from slot 13, with no Faerie Fire term", () => {
    for (const spec of ["mage", "shadow", "warlock"] as const) {
      const budget = hitCapBudgetFrom(
        capProfileFor(spec),
        request("TristateEffectImproved"),
        pseudoStats({ melee: 2, spell: 10 }),
        { 32: 1 }
      );
      expect(budget?.stat, spec).toBe(Stat.StatSpellHitRating);
      expect(budget?.remaining, spec).toBeCloseTo(
        (16 - 10) * SPELL_HIT_RATING_PER_HIT_PERCENT,
        9
      );
    }
  });

  it("gives a full-weight spec no budget even when both hit slots are read", () => {
    for (const spec of ["hunter", "balance", "ele"] as const) {
      expect(
        hitCapBudgetFrom(
          capProfileFor(spec),
          request("TristateEffectImproved"),
          pseudoStats({ melee: 5, spell: 5 })
        ),
        spec
      ).toBeUndefined();
    }
  });

  it("gives no budget when a target is not level 73", () => {
    for (const spec of ["ret", "mage"] as const) {
      for (const levels of [[72], [73, 72]]) {
        expect(
          hitCapBudgetFrom(
            capProfileFor(spec),
            request(undefined, levels),
            pseudoStats({ melee: 5, spell: 5 })
          ),
          `${spec} ${levels.join(",")}`
        ).toBeUndefined();
      }
    }
  });
});
