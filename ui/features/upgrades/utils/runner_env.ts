import type { RunnerEnv } from '../model/adapters/bulk_wasm_sim_runner';

// The only file in the Upgrades feature that reads these browser globals:
// `model/` is lint-barred from them, so the run model takes this value instead.
export const RUNNER_ENV: RunnerEnv = {
	storageRead: key => localStorage.getItem(key),
	hardwareConcurrency: navigator.hardwareConcurrency,
	deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
};
