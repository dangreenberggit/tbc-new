import { fakeTabHost, memoryStorage, settled } from '@features/upgrades/testing/fake_tab_host';
import { Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Whether the page has loaded the tab's bundled item data, which the built site downloads as part of the tab's store
 * chunk. A file of its own, so no other test has loaded the data first.
 */
const loaded = vi.hoisted(() => ({ data: false }));
vi.mock('@features/upgrades/model/data/data', async importOriginal => {
	loaded.data = true;
	return importOriginal();
});

const { UpgradesTabBody } = await import('./UpgradesTabBody');

const KEY = '__upgrades_test__upgradesSettings__';
const savedEntry = (settings: object) => JSON.stringify({ version: 1, settings, sort: [{ id: 'source', desc: true }], view: {}, exportFlavour: 'gear' });

/**
 * A page at phase 3 whose Upgrades tab is closed, on real page subscriptions. `load` is the page's own settings load,
 * which the page queues on its start-up before any tab code runs (`app/individual_sim_ui.tsx`).
 */
const closedPage = (spec: Spec, storage: ReturnType<typeof memoryStorage>, load?: (setPhase: (phase: number) => void) => void) => {
	const store = createSimStore();
	const setPhase = (phase: number) => patchSlice(store, 'sim', { phase });
	setPhase(3);
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
	])('downloads none of the tab’s data on a phase change, on %s', async (_, spec) => {
		const page = closedPage(spec, memoryStorage({ [KEY]: savedEntry({ selectedSetKeys: [], defaultsFor: 'ret:3' }) }));
		await page.finishInit();

		act(() => page.setPhase(4));
		await act(settled);
		await vi.dynamicImportSettled();

		expect(loaded.data).toBe(false);
	});

	// Ticket 564's rule, kept for a tab that never opens (ticket 587): the next open applies the new phase's defaults.
	it('saves a phase change as the saved sets’ reset, and keeps every other saved choice', async () => {
		const storage = memoryStorage({
			[KEY]: savedEntry({ selectedSetKeys: [], excludedSources: ['Hyjal Summit'], iterations: 4321, defaultsFor: 'ret:3' }),
		});
		const page = closedPage(Spec.SpecRetributionPaladin, storage);
		await page.finishInit();

		act(() => page.setPhase(4));

		expect(JSON.parse(storage.entries.get(KEY)!)).toEqual({
			version: 1,
			settings: { selectedSetKeys: [], excludedSources: ['Hyjal Summit'], iterations: 4321 },
			sort: [{ id: 'source', desc: true }],
			view: {},
			exportFlavour: 'gear',
		});
	});

	it('writes nothing on a phase change when the page has saved no settings', async () => {
		const storage = memoryStorage();
		const page = closedPage(Spec.SpecRetributionPaladin, storage);
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
		const page = closedPage(Spec.SpecRetributionPaladin, storage, setPhase => setPhase(4));

		await page.finishInit();

		expect(storage.entries.get(KEY)).toBe(saved);
	});
});
