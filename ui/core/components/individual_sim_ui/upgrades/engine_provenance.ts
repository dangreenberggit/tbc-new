/**
 * Fork commit identifier for the assumptions drawer (plan §4 "engine
 * provenance = fork commit").
 *
 * The fork has no build-time git-info plumbing (no `git describe` step in
 * `vite.config.mts` or the worker build), so this cannot be read at runtime
 * the way `WasmSimRunner.version()` reads `CURRENT_API_VERSION` from an
 * already-exported constant. This is a hand-maintained literal instead of an
 * invented one.
 *
 * Convention: the literal names the last fork commit that changed engine
 * behaviour. It may lag HEAD by provenance-only commits — such as the commit
 * that updates this literal — because a commit cannot contain its own hash.
 * Update it in any commit that changes what the engine does; a commit that
 * touches only this file leaves it pointing at its predecessor, which is
 * correct under this convention. If it drifts further than that, the cost is
 * a wrong-but-honest-looking label in the drawer, not a silent behavior
 * change — nothing downstream reads it.
 */
export const ENGINE_FORK_COMMIT = "8db275d7d";
