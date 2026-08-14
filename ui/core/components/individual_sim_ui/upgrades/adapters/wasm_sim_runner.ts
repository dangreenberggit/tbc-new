/**
 * WasmSimRunner — SimRunner over the site's own in-browser WASM simulator
 * (plan §2.4).
 *
 * Owns an independent `WorkerPool`, rather than reaching into `Sim`'s
 * private `workerPool` field — `Sim.workerPool` has no public accessor
 * (`ui/core/sim.ts`), and `WorkerPool`'s own constructor is self-contained
 * (points every worker at the fixed `SIM_WORKER_URL`, no dependency on `Sim`
 * state), so a second pool is the same kind of object the page already runs,
 * not a workaround.
 *
 * Deliberately does **not** call `runConcurrentSim`
 * (`ui/core/sim_concurrent.ts`): that function splits *one request's
 * iterations* across workers by sharding the seed
 * (`sim/core/sim_concurrent.go`'s `SplitSimRequestForConcurrency`), which is
 * a different number for a different worker count (confirmed empirically in
 * `docs/plans/compute-topology.md` §3.1 — same seed, different core count,
 * different float in the last few digits). Plan §2.4 names the actual
 * upstream idiom for many small requests: "there is no bulk RPC — upstream's
 * own Batch tab loops one ordinary sim per combination client-side" — so
 * `raidSimAsync` is called once per candidate, unsharded, and the pool's own
 * least-busy-worker balancing (`WorkerPoolManager`) is what runs several
 * candidates concurrently.
 */

import { RaidSimRequest as RaidSimRequestProto } from "../../../../proto/api.js";
import { CURRENT_API_VERSION } from "../../../../constants/other.js";
import {
  generateRequestId,
  WorkerPool,
} from "../../../../worker_pool.js";
import { SimRequest } from "../../../../../worker/types.js";
import { RequestTypes, SimSignalManager } from "../../../../sim_signal_manager.js";
import type {
  RaidSimRequest,
  SimObservation,
  SimRunOpts,
  SimRunner,
} from "../engine/seams/sim-runner.js";

/** Matches upstream's own default (`ui/core/sim.ts`'s WorkerPool(1) plus its
 * wasm-concurrency auto-sizing, capped at 4 — see that file's constructor). */
export const DEFAULT_WORKER_COUNT = 4;

export class WasmSimRunner implements SimRunner {
  private readonly pool: WorkerPool;
  private readonly signalManager = new SimSignalManager();

  constructor(numWorkers: number = DEFAULT_WORKER_COUNT) {
    this.pool = new WorkerPool(numWorkers);
  }

  async version(): Promise<string> {
    return `api-v${CURRENT_API_VERSION}`;
  }

  async run(req: RaidSimRequest, opts: SimRunOpts): Promise<SimObservation> {
    const withOptions = {
      ...req,
      requestId: generateRequestId(SimRequest.raidSimAsync),
      simOptions: {
        iterations: opts.iterations,
        // protobuf-ts int64 fields accept a numeric string on fromJson;
        // matches how the CLI seam (packages/core/src/seams/cli-sim-runner.ts)
        // and the recorded fixtures already spell a seed (D4's sibling
        // adaptation, same convention, not a new one invented here).
        randomSeed: String(opts.seed),
        debugFirstIteration: false,
      },
    };

    const proto = RaidSimRequestProto.fromJson(withOptions, {
      ignoreUnknownFields: true,
    });

    const signals = this.signalManager.registerRunning(RequestTypes.RaidSim);
    try {
      const result = await this.pool.raidSimAsync(proto, () => {}, signals);
      if (result.error) {
        throw new Error(
          `sim error (${result.error.type}): ${result.error.message}`
        );
      }
      const dps = result.raidMetrics?.dps;
      if (!dps) {
        throw new Error("sim result has no raidMetrics.dps");
      }
      return {
        dps: dps.avg,
        stdev: dps.stdev,
        iterationsDone: result.iterationsDone,
        simVersion: await this.version(),
      };
    } finally {
      this.signalManager.unregisterRunning(signals);
    }
  }
}
