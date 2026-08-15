/**
 * Fork commit identifier for the assumptions drawer (plan §4 "engine
 * provenance = fork commit").
 *
 * The fork has no build-time git-info plumbing (no `git describe` step in
 * `vite.config.mts` or the worker build), so this cannot be read at runtime
 * the way `WasmSimRunner.version()` reads `CURRENT_API_VERSION` from an
 * already-exported constant. This is a hand-maintained literal instead of an
 * invented one: update it in the same commit that changes anything under
 * `upgrades/`, so the drawer never claims a commit that isn't the one
 * running. If this ever drifts, the cost is a wrong-but-honest-looking label
 * in the drawer, not a silent behavior change — nothing downstream reads it.
 */
export const ENGINE_FORK_COMMIT = "f7146dd69";
