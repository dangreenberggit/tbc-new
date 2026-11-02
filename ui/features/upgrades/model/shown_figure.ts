/**
 * The tenths of a DPS a row's figure shows. A positive figure below the
 * ranking's bar that would round to the bar or above shows one tenth under it,
 * so a row below the cutoff never reads as meeting it (ticket 618). The cell and
 * the set-bonus popover both use this, so the popover's lines add up to the
 * figure the cell shows.
 */
export const shownTenths = (value: number, bar?: number): number => {
	const t = tenthsOf(value);
	if (bar === undefined || value <= 0 || value >= bar) return t;
	const barTenths = tenthsOf(bar);
	return t >= barTenths ? barTenths - 1 : t;
};

/** `value` in tenths of a DPS, rounded as `toFixed(1)` prints it, so a figure and its printed text agree. */
export const tenthsOf = (value: number): number => Math.round(Number(value.toFixed(1)) * 10);
