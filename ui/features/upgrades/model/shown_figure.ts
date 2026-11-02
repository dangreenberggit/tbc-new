/**
 * The tenths of a DPS a row's figure shows. A positive figure below the
 * ranking's bar that would round to the bar or above shows one tenth under it,
 * so a row below the cutoff never reads as meeting it (ticket 618). The cell and
 * the set-bonus popover both use this, so the popover's lines add up to the
 * figure the cell shows.
 */
export const shownTenths = (value: number, bar?: number): number => {
	const t = Math.round(Number(value.toFixed(1)) * 10);
	if (bar === undefined || value <= 0 || value >= bar) return t;
	const barTenths = Math.round(Number(bar.toFixed(1)) * 10);
	return t >= barTenths ? barTenths - 1 : t;
};
