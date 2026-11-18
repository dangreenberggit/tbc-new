/**
 * The DPS gain a row needs to count as an upgrade, the same for every spec. The 3 is a
 * rough cut against sim noise, not a measured figure. It is applied before the top rows
 * are rerun on more seeds and picks which rows those are, so it reads the first-seed
 * `deltaDps` (`seMethod: 'independent'`).
 */
export type Cutoff = { readonly absDps: number };

export const CUTOFF: Cutoff = { absDps: 3 };

/**
 * Noise floor for a set-bonus figure that combines four sims (a ranking made without
 * `measureSetBonuses`): √2 × `absDps`, as four sims' combined SE (`combineSe`) is about
 * √2 times one delta's. A 4pc bonus combines six but keeps this lower floor on purpose, so
 * a bonus gets through rather than hidden. Only a figure strictly above it counts.
 *
 * The popover and the row sort both read the floor from the `Cutoff` stored on the
 * `Ranking`, not the current constant, so no row sorts on a bonus the popover hides.
 */
export function setBonusNoiseFloorDps(cutoff: Cutoff): number {
	return Math.SQRT2 * cutoff.absDps;
}

export function meetsCutoff(deltaDps: number, cutoff: Cutoff): boolean {
	return deltaDps >= cutoff.absDps;
}
