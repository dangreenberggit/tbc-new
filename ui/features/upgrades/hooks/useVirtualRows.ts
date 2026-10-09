import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/**
 * A row's height until it is measured: the median `upgrades-result-row` height,
 * 43 px, over all 451 rows of `ret-p3-p2`'s Upgrades list with the below-cutoff
 * group open, at 1280 x 900 in headless Chrome (ticket 565, 2026-10-09). Measured
 * by scrolling `div[data-testid="sim-ui"]` top to bottom and reading each row's
 * `getBoundingClientRect().height` once by `data-index`; the 10th and 90th
 * percentiles were 29 and 77.5 px. The median, not the largest likely height the
 * Virtual docs suggest: at 78 px, scrolling up from the middle or the bottom of
 * that list moved the rows on screen by up to 35 px, against 1 px at 43, though
 * it cleared the 19 px blank band the first frame of each upward step shows at 43.
 */
const ESTIMATED_ROW_HEIGHT = 43;

const OVERSCAN = 10;

/**
 * Firefox measures a table row's collapsed border differently, so it keeps
 * virtual-core's default measure, as TanStack Table's virtualized-rows example
 * does. Firefox still measures each row, rounded; whether that error is smaller
 * there than the border's is not measured (ticket 565).
 */
const IS_FIREFOX = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');

/**
 * The page's scroll box (`SimShell`). Found by test id, not by `findScrollParent`:
 * the table's own scroll box is `overflow-x: auto`, which computes its
 * `overflow-y` to `auto` too, so the nearest scrolling parent is the table's box,
 * which never scrolls vertically.
 */
const SCROLL_BOX = '[data-testid="sim-ui"]';
const PANE = '[data-testid="tab-pane"]';

const scrollBoxOf = (tbody: HTMLElement | null) => tbody?.closest<HTMLElement>(SCROLL_BOX) ?? null;

export interface VirtualRows {
	/** The indexes of the rows to render, in order: the ones in view plus the overscan. */
	indexes: readonly number[];
	/** The height of the rows not rendered above and below them, which spacer rows stand in for. */
	paddingTop: number;
	paddingBottom: number;
	/** A ref for each rendered row, read with its `data-index`; its real height replaces the estimate. */
	measureRow: (row: HTMLTableRowElement | null) => void;
}

/**
 * Which of a table's rows to render: only those in or near the page's view
 * (ticket 565). `keys` are the rows' ids in the table's order, so a row's
 * measured height follows the row when a sort moves it. The rows' offset in
 * the scroll box is measured after every render and whenever the page's content
 * or the pane changes size, because the below-cutoff table moves when the
 * shortlist above it changes height.
 */
export const useVirtualRows = (keys: readonly string[], tbodyRef: RefObject<HTMLTableSectionElement | null>): VirtualRows => {
	const [scrollMargin, setScrollMargin] = useState(0);

	// Stable, so the observer below is set up once per table rather than on every render.
	const measureMargin = useCallback(() => {
		const tbody = tbodyRef.current;
		const scrollBox = scrollBoxOf(tbody);
		if (!tbody || !scrollBox || tbody.offsetParent === null) return;
		const next = tbody.getBoundingClientRect().top - scrollBox.getBoundingClientRect().top + scrollBox.scrollTop;
		// Sub-pixel noise from the scroll position would re-render for nothing.
		setScrollMargin(current => (Math.abs(current - next) < 1 ? current : next));
	}, [tbodyRef]);

	// After every render as well as on resize: the plan's rule (ticket 565, step 13), and it covers a move that
	// resizes neither watched element, such as content above the table changing while the page is shorter than
	// the screen (the scroll box's content keeps its screen height then). Two rect reads; the state holds
	// within 1 px, so it cannot loop.
	useLayoutEffect(measureMargin);

	useLayoutEffect(() => {
		const tbody = tbodyRef.current;
		const scrollBox = scrollBoxOf(tbody);
		if (!tbody || !scrollBox) return;
		const observer = new ResizeObserver(measureMargin);
		// The scroll box's content grows when anything above the table does; the pane, when the shortlist above the
		// below-cutoff table does. The in-flight table sits outside any pane, so it has only the first.
		for (const watched of [scrollBox.firstElementChild, tbody.closest(PANE)]) {
			if (watched) observer.observe(watched);
		}
		return () => observer.disconnect();
	}, [tbodyRef, measureMargin]);

	// Stable while `keys` is: the virtualiser recomputes every row's position when `getItemKey` changes.
	const getItemKey = useCallback((index: number) => keys[index] ?? index, [keys]);

	const virtualizer = useVirtualizer({
		count: keys.length,
		getScrollElement: () => scrollBoxOf(tbodyRef.current),
		getItemKey,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		overscan: OVERSCAN,
		scrollMargin,
		// The fractional height: the default rounds each row, and the rounding adds up over hundreds of rows.
		measureElement: IS_FIREFOX ? undefined : row => row.getBoundingClientRect().height,
		// Until the scroll box is measured, as `VirtualList` does: with no height the first render has no rows.
		initialRect: { width: 0, height: 900 },
		// The default flushes from a row's ref callback, which React 19 warns about; with the default, scrolling up
		// into rows not yet measured moved the rows on screen by up to 262 px. The cost: the first frame after a
		// scroll can show the spacer before the rows, 19-27 px on a half-screen step, the whole view after a jump
		// (ticket 565).
		useFlushSync: false,
	});

	const items = virtualizer.getVirtualItems();
	const first = items[0];
	const last = items.at(-1);
	return {
		indexes: items.map(item => item.index),
		paddingTop: first ? first.start - scrollMargin : 0,
		paddingBottom: last ? virtualizer.getTotalSize() - (last.end - scrollMargin) : 0,
		measureRow: virtualizer.measureElement,
	};
};
