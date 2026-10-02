/**
 * The set screen (ticket 511, stages K5R and K5ON; ADR-0035).
 *
 * FORK-ONLY, no packages/core ancestor. A screen is a cheap first pass over
 * every set the gain side covers. It decides which sets get the exact
 * per-bonus measurement (`.scratch/stage-gate/511-512-set-credit/
 * set-screening-plan.md` §2; gitignored, ADR-0035 records the result),
 * because that measurement costs most of a run's set sims and most sets a
 * player is offered are not worth collecting.
 *
 * Per set S worn at w, with R the highest count the pool can reach and R − w
 * at least 2: on the gear of S's package at R, rung k (k = 0 … R − w) sends
 * the package's first k added pieces, in slot order, as set-kept copies and
 * the rest as set-less copies, so Go counts w + k pieces of S (the gate's
 * copies-in-both form, `set-less-copies.ts`). The pair is rungs 0 and R − w.
 * Every sim asks for per-iteration values, and the rungs share a seed, so a
 * difference of two rungs has a paired standard error.
 *
 * Record mode runs the pair at four iteration counts and the whole ladder,
 * and records them, so candidate rules can be scored offline. It filters
 * nothing.
 *
 * On mode, the tab's default, runs only the pair at the rule's iteration
 * count and applies `SCREEN_ON_RULE`. A set it drops gets no gate, package
 * or step sims; `rank.ts` gives it one "screened-out" marker entry. A set
 * whose readings failed is kept, so a sim failure never hides a set (the
 * known case is ticket 532: off-class Cryptstalker sims fail).
 *
 * Neither mode holds a table of set ids or piece counts.
 */

import type {
  RaidSimRequest,
  SimObservation,
  SimRunOpts,
} from "./seams/sim-runner.js";
import { applyCopies } from "./set-less-copies.js";

export type SetScreenMode = "off" | "record" | "on";

/** Iteration counts of the pair, and of the ladder (set-screening-plan.md Q4). */
export const SCREEN_PAIR_ITERATIONS: readonly number[] = [10, 100, 300, 1000];
export const SCREEN_LADDER_ITERATIONS: readonly number[] = [100, 300, 1000];

export type ScreenOnRule = {
  /** M2: the best count's package estimate plus the pair. */
  measure: "M2";
  iterations: number;
  /** K: the sets with the highest measures that are always kept. */
  keep: number;
  /** c: the band below the K-th measure is c·√2·σ wide. */
  bandC: number;
  /** Rule 1: drop a set whose pair reads exactly 0. */
  dropExactZero: boolean;
  /** σ = sigmaBoundScale · √2 · baseline stdev / √iterations. */
  sigmaBoundScale: number;
};

/**
 * The on mode's rule: the runner-up of the K5E scoring, which kept every set
 * worth collecting on all eleven check characters under σ, 1.5 × σ and each
 * reading's own paired error (`.scratch/stage-gate/511-512-set-credit/k5e/
 * report.md`; gitignored, ADR-0035 records the result). The orchestrator
 * chose it over the cheaper top pick at Gate C on 2026-10-01 (Q-K5E-rule),
 * because the top pick kept three needed sets only through its band;
 * ADR-0035 records both. Changing any constant needs a new K5E-style scoring
 * of the check characters.
 */
export const SCREEN_ON_RULE = {
  measure: "M2",
  iterations: 300,
  keep: 2,
  bandC: 1,
  dropExactZero: true,
  sigmaBoundScale: 1,
} as const;

export type ScreenReason =
  | "exact-zero"
  | "readings-absent"
  | "below-zero"
  | "top-k"
  | "band"
  | "outside-band";

export type SetScreenPair = {
  iterations: number;
  /** Rung R − w minus rung 0. Absent when either sim failed. */
  dps?: number;
  /** sd(a_i − b_i)/√N over the two sims' per-iteration values. */
  pairedSe?: number;
};

export type SetScreenRung = {
  iterations: number;
  /** The pieces of the set Go counts on this rung. */
  count: number;
  /** The rung's own DPS reading. Absent when its sim failed. */
  dps?: number;
  se?: number;
  /** The paired error of this rung minus the rung one count below. */
  pairedSeToPrev?: number;
};

export type SetScreenSet = {
  setId: number;
  worn: number;
  reach: number;
  /** The package's added pieces at `reach`, in slot order. */
  packageItemIds: number[];
  pairs: SetScreenPair[];
  /** Grouped by iteration count, then in count order. */
  rungs: SetScreenRung[];
};

export type SetScreenRecord = {
  mode: "record";
  seed: number;
  pairIterations: number[];
  ladderIterations: number[];
  sets: SetScreenSet[];
  /** Sims sent to the runner, failed ones included. */
  simmed: number;
  /** Sims the store answered. */
  fromStore: number;
};

export type SetScreenOnSet = {
  setId: number;
  worn: number;
  reach: number;
  /** The package's added pieces at `reach`, in slot order. */
  packageItemIds: number[];
  /** Rung R − w minus rung 0, absent when either sim failed. */
  pair: { dps?: number; pairedSe?: number };
  /** The highest package estimate over the counts in reach, if any. */
  bestStats?: number;
  /** `bestStats + pair.dps` (M2), absent when either is. */
  measure?: number;
  kept: boolean;
  reason: ScreenReason;
};

export type SetScreenOn = {
  mode: "on";
  seed: number;
  iterations: number;
  rule: Readonly<ScreenOnRule>;
  /** Absent when the baseline stdev is not a finite number. */
  sigma?: number;
  sets: SetScreenOnSet[];
  /** Sims sent to the runner, failed ones included. */
  simmed: number;
  /** Sims the store answered. */
  fromStore: number;
};

export type SetScreen = SetScreenRecord | SetScreenOn;

/** A set's package at its reach: the composed request and its added pieces. */
export type ScreenPackage = {
  request: RaidSimRequest;
  /** The added pieces' slot indices and item ids, in slot order. */
  added: ReadonlyArray<{ slotIndex: number; itemId: number }>;
};

export type SetScreenInput = {
  /** The gain-side sets: each set's worn count and its reach R. */
  sets: ReadonlyArray<{ setId: number; worn: number; reach: number }>;
  /**
   * The package of `setId` at `count`, built as the package loop builds it
   * (selected pieces swapped in with gem repair, then composed). Undefined
   * when it cannot be built.
   */
  packageAt: (setId: number, count: number) => ScreenPackage | undefined;
  /** A store-cached sim with explicit options. Throws when the sim fails. */
  runSimAt: (
    request: RaidSimRequest,
    opts: SimRunOpts
  ) => Promise<{ observation: SimObservation; fromStore: boolean }>;
  seed: number;
  /**
   * The caller's Stop. Once it has aborted, a failed reading is the runner
   * refusing the sim and the caller drops the screen, so the reading writes
   * no warning (ticket 533).
   */
  signal?: AbortSignal;
  pairIterations?: readonly number[];
  ladderIterations?: readonly number[];
};

export type SetScreenOnInput = Omit<
  SetScreenInput,
  "pairIterations" | "ladderIterations"
> & {
  /**
   * The package estimate of `setId` at `count`: the sum of its pieces'
   * single-swap figures plus rule Z's add-back for the worn bonuses they
   * share (`partner-choice.ts`). Undefined when an input is missing.
   */
  statsAt: (setId: number, count: number) => number | undefined;
  /** The baseline sim's per-iteration standard deviation. */
  baselineStdev: number;
};

type ScreenCounter = { simmed: number; fromStore: number };

/** The package at `reach` and its added pieces' slots, in slot order. */
function screenPackage(
  input: Pick<SetScreenInput, "packageAt">,
  setId: number,
  reach: number
) {
  const pkg = input.packageAt(setId, reach);
  const added = pkg
    ? [...pkg.added].sort((a, b) => a.slotIndex - b.slotIndex)
    : [];
  return { pkg, added, slots: added.map((p) => p.slotIndex) };
}

/**
 * One set's rung sim, shared by both modes so an on-mode pair is the same
 * request, with the same options, as a record-mode pair at that N. Each
 * reading catches its own failure, so one failed sim loses only that
 * reading.
 */
function rungSimmer(
  input: Pick<SetScreenInput, "runSimAt" | "seed" | "signal">,
  setId: number,
  worn: number,
  pkg: ScreenPackage | undefined,
  slots: readonly number[],
  counter: ScreenCounter
): (k: number, iterations: number) => Promise<SimObservation | undefined> {
  return async (k, iterations) => {
    if (!pkg) return undefined;
    const what = `[upgrades] set screen: set ${setId} at ${worn + k} pieces, ${iterations} iterations, not measured`;
    let request: RaidSimRequest;
    try {
      request = applyCopies(pkg.request, {
        setKept: slots.slice(0, k),
        setLess: slots.slice(k),
      });
    } catch (err) {
      console.warn(what, err);
      return undefined;
    }
    try {
      const { observation, fromStore: hit } = await input.runSimAt(request, {
        seed: input.seed,
        iterations,
        saveAllValues: true,
      });
      if (hit) counter.fromStore += 1;
      else counter.simmed += 1;
      return observation;
    } catch (err) {
      counter.simmed += 1;
      if (!input.signal?.aborted) console.warn(what, err);
      return undefined;
    }
  };
}

export async function recordSetScreen(
  input: SetScreenInput
): Promise<SetScreenRecord> {
  const pairIterations = [...(input.pairIterations ?? SCREEN_PAIR_ITERATIONS)];
  const ladderIterations = [
    ...(input.ladderIterations ?? SCREEN_LADDER_ITERATIONS),
  ];
  const counter: ScreenCounter = { simmed: 0, fromStore: 0 };
  const sets: SetScreenSet[] = [];

  for (const { setId, worn, reach } of input.sets) {
    if (reach - worn < 2) continue;
    const { pkg, added, slots } = screenPackage(input, setId, reach);
    const top = reach - worn;
    const rungAt = rungSimmer(input, setId, worn, pkg, slots, counter);

    const pairs: SetScreenPair[] = [];
    for (const iterations of pairIterations) {
      const low = await rungAt(0, iterations);
      const high = await rungAt(top, iterations);
      pairs.push({
        iterations,
        ...(low && high ? { dps: high.dps - low.dps } : {}),
        ...optionalPairedSe("pairedSe", high, low, iterations),
      });
    }

    const rungs: SetScreenRung[] = [];
    for (const iterations of ladderIterations) {
      let below: SimObservation | undefined;
      for (let k = 0; k <= top; k++) {
        const obs = await rungAt(k, iterations);
        rungs.push({
          iterations,
          count: worn + k,
          ...(obs
            ? { dps: obs.dps, se: obs.stdev / Math.sqrt(iterations) }
            : {}),
          ...(k > 0
            ? optionalPairedSe("pairedSeToPrev", obs, below, iterations)
            : {}),
        });
        below = obs;
      }
    }

    sets.push({
      setId,
      worn,
      reach,
      packageItemIds: added.map((p) => p.itemId),
      pairs,
      rungs,
    });
  }

  return {
    mode: "record",
    seed: input.seed,
    pairIterations,
    ladderIterations,
    sets,
    simmed: counter.simmed,
    fromStore: counter.fromStore,
  };
}

/**
 * The on mode: the pair at `SCREEN_ON_RULE.iterations` for each set with
 * R − w ≥ 2, in set id order, then `applyScreenRule`. Sets with R − w < 2
 * are not screened, so the caller keeps them.
 */
export async function runSetScreenOn(
  input: SetScreenOnInput
): Promise<SetScreenOn> {
  const rule = SCREEN_ON_RULE;
  const iterations = rule.iterations;
  const counter: ScreenCounter = { simmed: 0, fromStore: 0 };
  const readings: Omit<SetScreenOnSet, "kept" | "reason">[] = [];

  for (const { setId, worn, reach } of [...input.sets].sort(
    (a, b) => a.setId - b.setId
  )) {
    if (reach - worn < 2) continue;
    const { pkg, added, slots } = screenPackage(input, setId, reach);
    const rungAt = rungSimmer(input, setId, worn, pkg, slots, counter);
    const low = await rungAt(0, iterations);
    const high = await rungAt(reach - worn, iterations);
    const pairDps = low && high ? high.dps - low.dps : undefined;

    let bestStats: number | undefined;
    for (let t = Math.max(2, worn + 1); t <= reach; t++) {
      const stats = input.statsAt(setId, t);
      if (stats !== undefined && (bestStats === undefined || stats > bestStats)) {
        bestStats = stats;
      }
    }
    const measure =
      bestStats !== undefined && pairDps !== undefined
        ? bestStats + pairDps
        : undefined;

    readings.push({
      setId,
      worn,
      reach,
      packageItemIds: added.map((p) => p.itemId),
      pair: {
        ...(pairDps !== undefined ? { dps: pairDps } : {}),
        ...optionalPairedSe("pairedSe", high, low, iterations),
      },
      ...(bestStats !== undefined ? { bestStats } : {}),
      ...(measure !== undefined ? { measure } : {}),
    });
  }

  const sigma = Number.isFinite(input.baselineStdev)
    ? (rule.sigmaBoundScale * Math.SQRT2 * input.baselineStdev) /
      Math.sqrt(iterations)
    : undefined;
  const verdicts = applyScreenRule(
    readings.map((r) => ({
      setId: r.setId,
      ...(r.pair.dps !== undefined ? { pairDps: r.pair.dps } : {}),
      ...(r.measure !== undefined ? { measure: r.measure } : {}),
    })),
    sigma,
    rule
  );

  return {
    mode: "on",
    seed: input.seed,
    iterations,
    rule,
    ...(sigma !== undefined ? { sigma } : {}),
    sets: readings.map((r) => ({ ...r, ...verdicts.get(r.setId)! })),
    simmed: counter.simmed,
    fromStore: counter.fromStore,
  };
}

/**
 * Which screened sets the on mode keeps, and why. A port of `apply_rule` in
 * `.scratch/stage-gate/511-512-set-credit/k5e/score_screen.py` (bound mode;
 * gitignored, ADR-0035 records the result), so the scoring's verdict still
 * holds; keep the two in step. In ascending set id:
 *
 * 1. a pair of exactly 0 is dropped, before the absence check;
 * 2. an absent measure or σ keeps the set, outside the ranking;
 * 3. measure + 2σ < 0 is dropped;
 * 4. the rest are ranked by (−measure, set id), the first K kept;
 * 5. another set within c·√2·σ of the K-th measure (inclusive) is kept;
 * 6. the rest are dropped.
 */
export function applyScreenRule(
  sets: ReadonlyArray<{ setId: number; pairDps?: number; measure?: number }>,
  sigma: number | undefined,
  rule: Readonly<ScreenOnRule> = SCREEN_ON_RULE
): Map<number, { kept: boolean; reason: ScreenReason }> {
  const out = new Map<number, { kept: boolean; reason: ScreenReason }>();
  const ranked: Array<{ setId: number; measure: number }> = [];
  for (const set of [...sets].sort((a, b) => a.setId - b.setId)) {
    if (rule.dropExactZero && set.pairDps === 0) {
      out.set(set.setId, { kept: false, reason: "exact-zero" });
      continue;
    }
    if (
      set.measure === undefined ||
      sigma === undefined ||
      !Number.isFinite(sigma)
    ) {
      out.set(set.setId, { kept: true, reason: "readings-absent" });
      continue;
    }
    if (set.measure + 2 * sigma < 0) {
      out.set(set.setId, { kept: false, reason: "below-zero" });
      continue;
    }
    ranked.push({ setId: set.setId, measure: set.measure });
  }
  ranked.sort((a, b) =>
    a.measure !== b.measure ? b.measure - a.measure : a.setId - b.setId
  );
  if (ranked.length <= rule.keep) {
    for (const r of ranked) out.set(r.setId, { kept: true, reason: "top-k" });
    return out;
  }
  const measureK = ranked[rule.keep - 1]!.measure;
  const width = rule.bandC * Math.SQRT2 * sigma!;
  ranked.forEach((r, i) => {
    if (i < rule.keep) out.set(r.setId, { kept: true, reason: "top-k" });
    else if (r.measure >= measureK - width) {
      out.set(r.setId, { kept: true, reason: "band" });
    } else out.set(r.setId, { kept: false, reason: "outside-band" });
  });
  return out;
}

/** `{ [field]: sd(a_i − b_i)/√N }`, or nothing when either side lacks N values. */
function optionalPairedSe<K extends string>(
  field: K,
  a: SimObservation | undefined,
  b: SimObservation | undefined,
  iterations: number
): { [P in K]?: number } {
  const se = pairedSe(a?.allValues, b?.allValues, iterations);
  return (se === undefined ? {} : { [field]: se }) as { [P in K]?: number };
}

/**
 * The standard error of the mean per-iteration difference of two sims that
 * share a seed: sd(a_i − b_i)/√N, the batch sim's paired error
 * (sim/core/bulk/statistics.go). Undefined unless both have N values, N ≥ 2.
 */
export function pairedSe(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
  iterations: number
): number | undefined {
  if (
    !a ||
    !b ||
    iterations < 2 ||
    a.length !== iterations ||
    b.length !== iterations
  ) {
    return undefined;
  }
  let sum = 0;
  for (let i = 0; i < iterations; i++) sum += a[i]! - b[i]!;
  const mean = sum / iterations;
  let squares = 0;
  for (let i = 0; i < iterations; i++) {
    const d = a[i]! - b[i]! - mean;
    squares += d * d;
  }
  return Math.sqrt(squares / (iterations - 1)) / Math.sqrt(iterations);
}
