import { SAVED_VERSION } from '@features/upgrades/model/saved_entry';
import { memoryStorage, settled } from '@features/upgrades/testing/fake_tab_host';
import { Spec } from '@generated/proto/common';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether the page has loaded the tab's bundled item data, which the built site downloads as part of the tab's store
 * chunk. A file of its own, so no other test file has loaded the data first.
 */
const loaded = { data: false };

/**
 * Each case starts on a page that has loaded nothing, so a download in one case cannot fail or pass another. The mock
 * is registered again after the reset, because `vi.resetModules` keeps a mock's module and its factory would not run.
 */
beforeEach(() => {
	vi.resetModules();
	loaded.data = false;
	vi.doMock('@features/upgrades/model/data/data', async importOriginal => {
		loaded.data = true;
		return importOriginal();
	});
});

/**
 * Loading the tab's data takes more than the default 5 s on a cold transform. A test that loads it, or that would
 * load it if the tab regressed, gets this long, so a regression fails at its assertion and not by timeout.
 */
const LOADS_DATA_TIMEOUT_MS = 30_000;

/** The page's modules, imported after the reset, so the tab body and the provider share one context. */
const pageModules = async () => {
	const [{ UpgradesTabBody }, { SimHostProvider }, { createSimStore, patchSlice }, { fakeTabHost }] = await Promise.all([
		import('./UpgradesTabBody'),
		import('@sim/context/SimHostContext'),
		import('@sim/state/sim_store'),
		import('@features/upgrades/testing/fake_tab_host'),
	]);
	return { UpgradesTabBody, SimHostProvider, createSimStore, patchSlice, fakeTabHost };
};

const KEY = '__upgrades_test__upgradesSettings__';
const savedEntry = (settings: object) => JSON.stringify({ version: SAVED_VERSION, settings, sort: [{ id: 'source', desc: true }], view: {}, exportFlavour: 'gear' });

/**
 * A page at `startPhase` (3 unless given) whose Upgrades tab is closed, on real page subscriptions. `load` is the
 * page's own settings load, which the page queues on its start-up before any tab code runs (`app/individual_sim_ui.tsx`).
 */
const closedPage = async (
	spec: Spec,
	storage: ReturnType<typeof memoryStorage>,
	{ load, startPhase = 3 }: { load?: (setPhase: (phase: number) => void) => void; startPhase?: number } = {},
) => {
	const { UpgradesTabBody, SimHostProvider, createSimStore, patchSlice, fakeTabHost } = await pageModules();
	const store = createSimStore();
	const setPhase = (phase: number) => patchSlice(store, 'sim', { phase });
	setPhase(startPhase);
	let finish!: () => void;
	const init = new Promise<void>(resolve => (finish = resolve));
	if (load) void init.then(() => load(setPhase));
	const host = fakeTabHost({
		sim: { store, env: { storage }, waitForInit: () => init, getPhase: () => store.getState().sim.phase },
		player: { getSpec: () => spec },
	});
	render(
		<SimHostProvider host={host}>
			<div role="tabpanel" hidden>
				<UpgradesTabBody />
			</div>
		</SimHostProvider>,
	);
	return {
		setPhase,
		finishInit: async () => {
			finish();
			await act(settled);
		},
	};
};

describe('UpgradesTabBody while its tab has not been opened (ticket 589)', () => {
	it.each([
		['a spec with ranking data', Spec.SpecRetributionPaladin],
		['a spec with none', Spec.SpecProtectionPaladin],
	])(
		'downloads none of the tab’s data on a phase change, on %s',
		async (_, spec) => {
			const page = await closedPage(spec, memoryStorage({ [KEY]: savedEntry({ selectedSetKeys: [], defaultsFor: 'ret:3' }) }));
			await page.finishInit();

			act(() => page.setPhase(4));
			await act(settled);
			await vi.dynamicImportSettled();

			expect(loaded.data).toBe(false);
		},
		LOADS_DATA_TIMEOUT_MS,
	);

	// Ticket 564's rule, kept for a tab that never opens (ticket 587): the next open applies the new phase's defaults.
	it('saves a phase change as the saved sets’ reset, and keeps every other saved choice', async () => {
		const storage = memoryStorage({
			[KEY]: savedEntry({ selectedSetKeys: [], excludedSources: ['Hyjal Summit'], iterations: 4321, defaultsFor: 'ret:3' }),
		});
		const page = await closedPage(Spec.SpecRetributionPaladin, storage);
		await page.finishInit();

		act(() => page.setPhase(4));

		expect(JSON.parse(storage.entries.get(KEY)!)).toEqual({
			version: SAVED_VERSION,
			settings: { selectedSetKeys: [], excludedSources: ['Hyjal Summit'], iterations: 4321 },
			sort: [{ id: 'source', desc: true }],
			view: {},
			exportFlavour: 'gear',
		});
	});

	// A closed tab cannot read the pools, so only an open tab drops an exclusion its new phase does not offer. Review
	// round 3 of feat/tab-settings-persist accepted the difference (D-r3-2).
	it(
		'keeps, through a phase round trip, an exclusion the middle phase does not offer',
		async () => {
			await import('@features/upgrades/model/data/data');
			// The positive control: without it a mock that no longer matches the data module would pass every "downloads none" case.
			expect(loaded.data).toBe(true);
			// Zul'Aman opens in phase 4, so the phase-3 pool does not offer it. The pool is built from the page's item
			// database, which this page has not loaded, so the key is named rather than read from a pool.
			const onlyAt4 = "Zul'Aman";
			const storage = memoryStorage({ [KEY]: savedEntry({ selectedSetKeys: ['preset:4:P4'], excludedSources: [onlyAt4], defaultsFor: 'ret:4' }) });
			const page = await closedPage(Spec.SpecRetributionPaladin, storage, { startPhase: 4 });
			await page.finishInit();

			act(() => page.setPhase(3));
			act(() => page.setPhase(4));

			expect(JSON.parse(storage.entries.get(KEY)!).settings).toEqual({ selectedSetKeys: [], excludedSources: [onlyAt4] });
		},
		LOADS_DATA_TIMEOUT_MS,
	);

	it('writes nothing on a phase change when the page has saved no settings', async () => {
		const storage = memoryStorage();
		const page = await closedPage(Spec.SpecRetributionPaladin, storage);
		await page.finishInit();

		act(() => page.setPhase(4));
		await act(settled);
		await vi.dynamicImportSettled();

		expect(storage.entries.size).toBe(0);
	});

	// A3: the page's settings load writes the saved phase back; that is not a change.
	it('keeps the saved sets through the page’s own start-up phase write', async () => {
		const saved = savedEntry({ selectedSetKeys: ['preset:4:P4'], defaultsFor: 'ret:4' });
		const storage = memoryStorage({ [KEY]: saved });
		const page = await closedPage(Spec.SpecRetributionPaladin, storage, { load: setPhase => setPhase(4) });

		await page.finishInit();

		expect(storage.entries.get(KEY)).toBe(saved);
	});
});
