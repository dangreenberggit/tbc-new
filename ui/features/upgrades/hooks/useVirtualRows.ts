import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useCallback, useLayoutEffect, useState } from 'react';

/**
 * A row's height until it is measured: the median measured height, not the largest
 * likely height TanStack Virtual suggests, which shifts the rows on screen when
 * scrolling up into unmeasured rows.
 */
const ESTIMATED_ROW_HEIGHT = 43;

const OVERSCAN = 10;

/**
 * Firefox measures a table row's collapsed border differently, so it keeps the
 * default (rounded) measure, as TanStack Table's virtualized-rows example does.
 */
const IS_FIREFOX = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');

/**
 * The page's scroll box (`SimShell`), found by test id: `findScrollParent` would
 * return the table's own `overflow-x: auto` box, whose `overflow-y` computes to
 * `auto` too but which never scrolls vertically.
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
 * Which of a table's rows to render: only those in or near the page's view. `keys`
 * are the rows' ids in table order, so a measured height follows its row when a
 * sort moves it. The table's offset in the scroll box is re-measured after every
 * render and on resize, because content above it can change height.
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

	// After every render too, for a move that resizes neither watched element. The state holds within 1 px, so it
	// cannot loop.
	useLayoutEffect(measureMargin);

	useLayoutEffect(() => {
		const tbody = tbodyRef.current;
		const scrollBox = scrollBoxOf(tbody);
		if (!tbody || !scrollBox) return;
		const observer = new ResizeObserver(measureMargin);
		// The scroll box's content grows when anything above the table does; the pane, when the main table above the
		// below-cutoff table does. The table of a run in flight sits outside any pane, so it has only the first.
		for (const watched of [scrollBox.firstElementChild, tbody.closest(PANE)]) {
			if (watched) observer.observe(watched);
		}
		return () => observer.disconnect();
	}, [tbodyRef, measureMargin]);

	// Stable while `keys` is: the virtualizer recomputes every row's position when `getItemKey` changes.
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
		// The default flushes from a row's ref callback, which React 19 warns about, and shifts the rows when scrolling
		// up into unmeasured ones. The cost: the first frame after a scroll can show the spacer before the rows.
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
