/**
 * One flat bar for every spec, in DPS. The 3 is a rough cut against sim noise, not a
 * measured figure. The cutoff runs before replication and picks which rows get replicated,
 * so it reads the first-seed `deltaDps` (`seMethod: 'independent'`).
 */
export type Cutoff = { readonly absDps: number };

export const CUTOFF: Cutoff = { absDps: 3 };

/**
 * Noise floor for a set-bonus figure that folds four sims (a ranking made without
 * `measureBrokenSetValue`): √2 × `absDps`, as four sims' combined SE (`combineSe`) is about
 * √2 × one delta's. A 4pc bonus folds six but keeps this lower bar on purpose, because the
 * cutoff should admit rather than hide. A figure that is one sim minus another is held to
 * `absDps` itself. Only a figure strictly above the floor may move anything.
 *
 * The display and ranking gates both take the floor from the `Cutoff` on the rows'
 * `Ranking`, not a live lookup, so no row sorts on a bonus the display hides.
 */
export function setBonusNoiseFloorDps(cutoff: Cutoff): number {
	return Math.SQRT2 * cutoff.absDps;
}

/** Lives beside `CUTOFF` so the bar and the predicate that reads it stay one definition. */
export function meetsCutoff(deltaDps: number, cutoff: Cutoff): boolean {
	return deltaDps >= cutoff.absDps;
}
