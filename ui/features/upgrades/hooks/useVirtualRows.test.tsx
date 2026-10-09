import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useVirtualRows } from './useVirtualRows';

const VIEWPORT = 900;

/** Where the table starts in the page's content: below the tab's settings, as on the page. */
const TABLE_TOP = 300;

// happy-dom reports every element as 0x0 at the origin. `virtual-core` reads the scroll box's `offsetWidth`
// and `offsetHeight` (as `VirtualList.test.tsx` answers them), and the hook reads the tbody's top, which
// moves up as the page scrolls. The rows are never rendered here, so each keeps the estimated height.
const pageWith = () => {
	const scrollBox = document.createElement('div');
	scrollBox.dataset.testid = 'sim-ui';
	Object.defineProperty(scrollBox, 'offsetHeight', { value: VIEWPORT, configurable: true });
	Object.defineProperty(scrollBox, 'offsetWidth', { value: 1280, configurable: true });
	const table = document.createElement('table');
	const tbody = document.createElement('tbody');
	tbody.getBoundingClientRect = () => DOMRect.fromRect({ y: TABLE_TOP - scrollBox.scrollTop, width: 1280, height: 0 });
	table.append(tbody);
	scrollBox.append(table);
	document.body.append(scrollBox);
	return { scrollBox, tbodyRef: { current: tbody } };
};

const keys = (count: number) => Array.from({ length: count }, (_unused, index) => `row-${index}`);

afterEach(() => {
	document.body.replaceChildren();
});

describe('useVirtualRows', () => {
	it('renders only the rows in view and stands a spacer in for the rest', () => {
		const { tbodyRef } = pageWith();
		const { result } = renderHook(() => useVirtualRows(keys(467), tbodyRef));

		const { indexes, paddingTop, paddingBottom } = result.current;
		expect(indexes[0]).toBe(0);
		expect(indexes.length).toBeGreaterThan(0);
		expect(indexes.length).toBeLessThan(467);
		expect(paddingTop).toBe(0);
		expect(paddingBottom).toBeGreaterThan(0);
	});

	it('renders every row of a list that fits the view, with no spacer', () => {
		const { tbodyRef } = pageWith();
		const { result } = renderHook(() => useVirtualRows(keys(5), tbodyRef));

		expect(result.current.indexes).toEqual([0, 1, 2, 3, 4]);
		expect(result.current.paddingTop).toBe(0);
		expect(result.current.paddingBottom).toBe(0);
	});

	it('renders the last rows, and none of the first, once the page is scrolled to the bottom', async () => {
		const { scrollBox, tbodyRef } = pageWith();
		const { result } = renderHook(() => useVirtualRows(keys(467), tbodyRef));
		const bottom = TABLE_TOP + result.current.paddingBottom;

		Object.defineProperty(scrollBox, 'scrollTop', { value: bottom, configurable: true });
		await act(async () => {
			scrollBox.dispatchEvent(new Event('scroll'));
		});

		const { indexes, paddingTop, paddingBottom } = result.current;
		expect(indexes).toContain(466);
		expect(indexes).not.toContain(0);
		expect(paddingTop).toBeGreaterThan(0);
		expect(paddingBottom).toBe(0);
	});

	it('keeps a measured row’s height with the row when a sort moves it', () => {
		const { tbodyRef } = pageWith();
		const { result, rerender } = renderHook(({ order }) => useVirtualRows(order, tbodyRef), { initialProps: { order: keys(100) } });
		const unmeasured = { indexes: result.current.indexes, paddingBottom: result.current.paddingBottom };

		// `row-0`, first in this order, is 200 px tall: 157 px more than the estimate.
		const tall = document.createElement('tr');
		tall.dataset.index = '0';
		tall.getBoundingClientRect = () => DOMRect.fromRect({ width: 1280, height: 200 });
		act(() => result.current.measureRow(tall));

		// A sort moves `row-0` last, out of view; the row first now has never been measured.
		rerender({ order: keys(100).reverse() });

		expect(result.current.indexes).toEqual(unmeasured.indexes);
		expect(result.current.paddingBottom).toBeCloseTo(unmeasured.paddingBottom + 157);
	});
});
