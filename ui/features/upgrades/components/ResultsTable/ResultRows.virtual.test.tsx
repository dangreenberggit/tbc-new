import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureRow, RANKING_FIXTURE } from '../../testing/ranking_fixture';

// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('../RowToggles', () => ({ FavoriteToggle: () => <span data-testid="favorite-stub" />, BatchToggle: () => <span data-testid="batch-stub" /> }));
// The icon lookup fetches from wowhead; the rows' attributes are under test.
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));

const { ResultRows, ResultsTable } = await import('./ResultsTable');
const { useResultsTable } = await import('../../hooks/useResultsTable');
type RankedItem = import('../../model/engine/rank').RankedItem;
type RowContext = import('./ResultRow').RowContext;

loadEnglishBundles({ character: true });

// The attributes the main repo's tab harness trusts (`scripts/tab-harness/rows.mjs`): it counts a table's rows
// from the tbody's `data-row-count` and reads each row by `data-index` while it is rendered. Unlike
// `ResultsTable.test.tsx`, the windowing here is the real `useVirtualRows`, so fewer rows are rendered than ranked.
const RANKED = 200;
const VIEWPORT = 900;
const ROW_HEIGHT = 43;
/** Where the table starts in the page's content: below the tab's settings, as on the page. */
const TABLE_TOP = 300;

const CONTEXT: RowContext = { itemOf: () => undefined, sim: fakeHost().sim, tip: {}, tagsOf: () => [] };
const ROWS: RankedItem[] = Array.from({ length: RANKED }, (_unused, index) => ({
	...fixtureRow(index % RANKING_FIXTURE.items.length),
	itemId: 100_000 + index,
	rank: index + 1,
}));

const Bare = ({ rows }: { rows: readonly RankedItem[] }) => {
	const table = useResultsTable(rows, CONTEXT);
	return (
		<ResultsTable>
			<ResultRows table={table} rowContext={CONTEXT} />
		</ResultsTable>
	);
};

// happy-dom lays nothing out. `virtual-core` reads the page's scroll box size from `offsetHeight` and each rendered
// row's height through the hook's `measureElement`; every row is given one height, as on a page of one-line names.
// The hook reads the tbody's top, which moves up as the page scrolls (happy-dom's fixed 0 would put the table
// wherever the page is scrolled to).
let scrollBox: HTMLElement;
const rowRect = HTMLTableRowElement.prototype.getBoundingClientRect;
const sectionRect = HTMLTableSectionElement.prototype.getBoundingClientRect;
beforeEach(() => {
	scrollBox = document.createElement('div');
	scrollBox.dataset.testid = 'sim-ui';
	Object.defineProperty(scrollBox, 'offsetHeight', { value: VIEWPORT, configurable: true });
	Object.defineProperty(scrollBox, 'offsetWidth', { value: 1280, configurable: true });
	document.body.append(scrollBox);
	HTMLTableRowElement.prototype.getBoundingClientRect = () => DOMRect.fromRect({ width: 1280, height: ROW_HEIGHT });
	HTMLTableSectionElement.prototype.getBoundingClientRect = () => DOMRect.fromRect({ y: TABLE_TOP - scrollBox.scrollTop, width: 1280 });
});
afterEach(() => {
	HTMLTableRowElement.prototype.getBoundingClientRect = rowRect;
	HTMLTableSectionElement.prototype.getBoundingClientRect = sectionRect;
	document.body.replaceChildren();
});

const renderTable = () => {
	const container = scrollBox.appendChild(document.createElement('div'));
	return render(
		<SimHostProvider host={fakeHost({ player: { getSpec: () => undefined } })}>
			<Bare rows={ROWS} />
		</SimHostProvider>,
		{ container },
	);
};

const tbodyOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="upgrades-result-rows"]')!;
const renderedIndexes = (container: HTMLElement) =>
	[...container.querySelectorAll<HTMLElement>('[data-testid="upgrades-result-row"]')].map(row => row.dataset.index);
const spacers = (container: HTMLElement) => container.querySelectorAll('[data-testid="upgrades-row-spacer"]');

/** `count` consecutive indexes from `first`, as strings, the way `data-index` reads. */
const run = (first: number, count: number) => Array.from({ length: count }, (_unused, offset) => String(first + offset));

describe('ResultRows windowed by useVirtualRows', () => {
	it('counts every ranked row on the tbody while it renders only the first screen of them', () => {
		const { container } = renderTable();
		const indexes = renderedIndexes(container);

		expect(tbodyOf(container).dataset.rowCount).toBe(String(RANKED));
		expect(indexes.length).toBeGreaterThan(0);
		expect(indexes.length).toBeLessThan(RANKED);
		expect(indexes).toEqual(run(0, indexes.length));
		// The rows not rendered below the screen keep the table's full height.
		expect(spacers(container)).toHaveLength(1);
	});

	it('keeps the full count and renders a spacer row above and below the rendered rows once the page is scrolled into the table', async () => {
		const { container } = renderTable();

		Object.defineProperty(scrollBox, 'scrollTop', { value: TABLE_TOP + (RANKED / 2) * ROW_HEIGHT, configurable: true });
		await act(async () => {
			scrollBox.dispatchEvent(new Event('scroll'));
		});
		const indexes = renderedIndexes(container);

		expect(tbodyOf(container).dataset.rowCount).toBe(String(RANKED));
		expect(Number(indexes[0])).toBeGreaterThan(0);
		expect(Number(indexes.at(-1))).toBeLessThan(RANKED - 1);
		expect(indexes).toEqual(run(Number(indexes[0]), indexes.length));
		expect(spacers(container)).toHaveLength(2);
	});
});
