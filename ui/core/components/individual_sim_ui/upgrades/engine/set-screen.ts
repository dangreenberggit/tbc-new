/**
 * The set screen's record mode (ticket 511, stage K5R; ADR-0035).
 *
 * FORK-ONLY, no packages/core ancestor. A screen is a cheap first pass over
 * every set the gain side covers, meant to decide which sets get the exact
 * per-bonus measurement (`.scratch/stage-gate/511-512-set-credit/
 * set-screening-plan.md` §2). Record mode only runs and records the screen's
 * sims, so the exploration can score candidate rules offline. It filters
 * nothing, and nothing in the engine reads what it records.
 *
 * Per set S worn at w, with R the highest count the pool can reach and R − w
 * at least 2: on the gear of S's package at R, rung k (k = 0 … R − w) sends
 * the package's first k added pieces, in slot order, as set-kept copies and
 * the rest as set-less copies, so Go counts w + k pieces of S (the gate's
 * copies-in-both form, `set-less-copies.ts`). The pair is rungs 0 and R − w.
 * Every sim asks for per-iteration values, and the rungs share a seed, so a
 * difference of two rungs has a paired standard error. It holds no table of
 * set ids or piece counts.
 */

import type {
  RaidSimRequest,
  SimObservation,
  SimRunOpts,
} from "./seams/sim-runner.js";
import { applyCopies } from "./set-less-copies.js";

export type SetScreenMode = "off" | "record";

/** Iteration counts of the pair, and of the ladder (set-screening-plan.md Q4). */
export const SCREEN_PAIR_ITERATIONS: readonly number[] = [10, 100, 300, 1000];
export const SCREEN_LADDER_ITERATIONS: readonly number[] = [100, 300, 1000];

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

export type SetScreen = {
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
  pairIterations?: readonly number[];
  ladderIterations?: readonly number[];
};

export async function recordSetScreen(
  input: SetScreenInput
): Promise<SetScreen> {
  const pairIterations = [...(input.pairIterations ?? SCREEN_PAIR_ITERATIONS)];
  const ladderIterations = [
    ...(input.ladderIterations ?? SCREEN_LADDER_ITERATIONS),
  ];
  let simmed = 0;
  let fromStore = 0;
  const sets: SetScreenSet[] = [];

  for (const { setId, worn, reach } of input.sets) {
    if (reach - worn < 2) continue;
    const pkg = input.packageAt(setId, reach);
    const added = pkg
      ? [...pkg.added].sort((a, b) => a.slotIndex - b.slotIndex)
      : [];
    const slots = added.map((p) => p.slotIndex);
    const top = reach - worn;

    // Each reading catches its own failure, so one failed sim loses only that
    // reading.
    const rungAt = async (
      k: number,
      iterations: number
    ): Promise<SimObservation | undefined> => {
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
        if (hit) fromStore += 1;
        else simmed += 1;
        return observation;
      } catch (err) {
        simmed += 1;
        console.warn(what, err);
        return undefined;
      }
    };

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
    simmed,
    fromStore,
  };
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
