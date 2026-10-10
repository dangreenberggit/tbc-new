import type { EligibleCountProps } from '@features/upgrades/components/EligibleCount';
import type { FixtureAutoloadOptions } from '@features/upgrades/hooks/useFixtureAutoload';
import type { PoolEntry } from '@features/upgrades/model/engine/pool';
import type { RunDeps } from '@features/upgrades/model/run';
import type { RunOutcome, RunSettings } from '@features/upgrades/model/run_state';
import { fakeTabHost, memoryStorage, settled } from '@features/upgrades/testing/fake_tab_host';
import { loadEnglishBundles } from '@features/upgrades/testing/locales';
import { fixtureRow, RANKING_FIXTURE } from '@features/upgrades/testing/ranking_fixture';
import { Raid as RaidProto } from '@generated/proto/api';
import { Encounter as EncounterProto, EquipmentSpec, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchSlice } from '@sim/state/sim_store';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The live run, replaced by one the test settles by hand; the engine is never loaded. */
const runs: Array<{ settings: RunSettings; deps: RunDeps; settle: (outcome: RunOutcome) => void }> = [];
const contexts: Array<object> = [];
vi.mock('@features/upgrades/model/run', () => ({
	rankForPlayer: (_host: unknown, settings: RunSettings, deps: RunDeps) => new Promise<RunOutcome>(settle => runs.push({ settings, deps, settle })),
	createRunContext: () => {
		const context = {};
		contexts.push(context);
		return context;
	},
	specIdFor: () => 'ret',
}));

const entry = (itemId: number, zone: string, bis = false, phase = 3): PoolEntry => ({
	itemId,
	name: `item ${itemId}`,
	slot: 'head',
	phase,
	source: { kind: 'raid', zone },
	...(bis ? { bisTags: ['BiS'] } : {}),
});
/** A small pool per phase whose BiS tags speak for that phase, so the P3 preset is phase 3's default set and P4 phase 4's. */
const POOLS: Record<number, PoolEntry[]> = {
	3: [entry(1, 'Black Temple', true), entry(2, 'Hyjal Summit'), entry(3, 'Black Temple')],
	4: [entry(1, 'Black Temple'), entry(4, 'Zul’Aman', true, 4)],
};
vi.mock('@features/upgrades/model/data/data', async importOriginal => ({
	...(await importOriginal<typeof import('@features/upgrades/model/data/data')>()),
	poolFor: (_spec: string, phase: number) => POOLS[phase] ?? [],
	bisTagPhaseFor: (_spec: string, phase: number) => ({ tagsFromPhase: phase, requestedPhase: phase }),
}));

/**
 * The page's change source: every listener hears every page edit. The tab store's phase listener hears them too,
 * and a phase set with `patchSlice` rings none of them, so `useUpgradesSettings.test.tsx`, on real subscriptions,
 * is the test of the picks a phase change resets.
 */
const listeners = new Set<() => void>();
const pageChanged = () => listeners.forEach(listener => listener());
vi.mock('@sim/state/subscriptions', async () =>
	(await import('@sim/testing')).mockSubscriptions(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}),
);

/** The fixture hooks install nothing under vitest, so the test calls the loader the body hands them. */
const autoload: { current?: FixtureAutoloadOptions } = {};
vi.mock('@features/upgrades/hooks/useFixtureAutoload', () => ({ useFixtureAutoload: (options: FixtureAutoloadOptions) => (autoload.current = options) }));
vi.mock('@sim/hooks/useSimReady', () => ({ useSimReady: () => true }));
// The row toggles read the page's store; `RowToggles.test.tsx` covers them.
vi.mock('@features/upgrades/components/RowToggles', () => ({ FavoriteToggle: () => null, BatchToggle: () => null }));
vi.mock('@ui-kit/hooks/useActionId', () => ({ useActionId: () => ({ iconUrl: '', name: '', href: '', ready: true }) }));
/** The run card's renders, counted through a child it always renders and that is not itself memoised. */
const runCard = { renders: 0 };
vi.mock('@features/upgrades/components/EligibleCount', async importOriginal => {
	const { EligibleCount } = await importOriginal<typeof import('@features/upgrades/components/EligibleCount')>();
	return {
		EligibleCount: (props: EligibleCountProps) => {
			runCard.renders++;
			return <EligibleCount {...props} />;
		},
	};
});

const { UpgradesTabBody } = await import('./UpgradesTabBody');
const { UpgradesTabBodyInner } = await import('@features/upgrades/components/UpgradesTab');
const { useUpgradesSettings } = await import('@features/upgrades/hooks/useUpgradesSettings');
const { selectRunStatus, useUpgradesStore } = await import('@features/upgrades/hooks/useUpgradesStore');

loadEnglishBundles({ character: true });

/** The worn gear the key reads; a test changes it to edit the page. */
let worn = 'P2 preset';
const PRESETS = [
	{ name: 'P3', phase: 3, gear: EquipmentSpec.create({ items: [{ id: 1 }] }) },
	{ name: 'P4', phase: 4, gear: EquipmentSpec.create({ items: [{ id: 4 }] }) },
];

/** A fresh page per case, so each case gets its own tab store (the store is keyed by the page's `Sim`); a reload passes the last page's storage. */
const makeHost = (storage = memoryStorage()) => {
	const store = createSimStore();
	patchSlice(store, 'sim', { phase: 3 });
	const host = fakeTabHost({
		player: { getGear: () => ({ getEquippedItems: () => [] }), getSpec: () => Spec.SpecRetributionPaladin },
		sim: {
			store,
			env: { storage },
			db: { getItemById: () => undefined },
			raid: { toProto: () => RaidProto.create({ parties: [{ players: [{ name: worn }] }] }) },
			encounter: { toProto: () => EncounterProto.create({ duration: 180 }) },
			getPhase: () => store.getState().sim.phase,
			setPhase: (phase: number) => patchSlice(store, 'sim', { phase }),
		},
		individualConfig: { presets: { gear: PRESETS } },
		getSavedGearStorageKey: () => 'upgrades-tab-body-test-gear',
	});
	return { host, store, storage };
};
let current = makeHost();

const rowA = fixtureRow(0);
const rowB = fixtureRow(1);

beforeEach(() => {
	runs.length = 0;
	contexts.length = 0;
	worn = 'P2 preset';
	current = makeHost();
});

const mount = (outside?: ReactNode) =>
	render(
		<SimHostProvider host={current.host}>
			{outside}
			<UpgradesTabBodyInner />
		</SimHostProvider>,
	);

const clickRun = () => {
	fireEvent.click(screen.getByTestId('upgrades-run-button'));
	const run = runs.at(-1);
	if (!run) throw new Error('Run did not start a run');
	return run;
};

/** The rows a reader sees: the one table while a run is in flight, the open sub-tab's table after (every pane stays mounted). */
const tableRows = () => {
	const openPane = document.querySelector<HTMLElement>('[data-testid="tab-pane"]:not([inert]):not([hidden])');
	return within(within(openPane ?? document.body).getByTestId('upgrades-results-table')).getAllByTestId('upgrades-result-row');
};

const tabRoot = () => screen.getByTestId('upgrades-tab-root');

/** Code outside the tab that reads the tab's run state and effective settings, as another part of the page would. */
const Probe = () => {
	const status = useUpgradesStore(selectRunStatus);
	const { selectedKeys, runSettings } = useUpgradesSettings();
	return (
		<>
			<span data-testid="probe-run-status">{status}</span>
			<span data-testid="probe-set-keys">{[...selectedKeys].sort().join(',')}</span>
			<span data-testid="probe-iterations">{runSettings.iterations}</span>
		</>
	);
};
const probe = (field: string) => screen.getByTestId(`probe-${field}`).textContent;

/** The sets the tab's chips show as selected. */
const tabSetKeys = () =>
	screen
		.getAllByTestId('upgrades-set-chip')
		.filter(chip => chip.querySelector('[aria-pressed="true"]'))
		.map(chip => chip.dataset.setKey)
		.sort()
		.join(',');
const tabIterations = () => (within(screen.getByTestId('upgrades-iterations-picker')).getByRole('textbox') as HTMLInputElement).value;

describe('UpgradesTabBody', () => {
	it('shows rows as they land, and keeps them when Stop ends the run', async () => {
		mount();
		const run = clickRun();
		expect(screen.getByTestId('upgrades-run-progress')).not.toBeNull();

		act(() => {
			run.deps.onLanded(rowA);
			run.deps.onLanded(rowB);
		});
		expect(tableRows()).toHaveLength(2);

		fireEvent.click(screen.getByTestId('progress-tracker-modal-cancel-btn'));
		expect(run.deps.signal.aborted).toBe(true);
		// The dialog covers the status line for the whole wait, so the dialog itself says so.
		expect(screen.getByTestId('progress-tracker-modal-message').textContent).toBe('Stopping — finishing the current step.');
		await act(async () => run.settle({ ...RANKING_FIXTURE, items: [rowA, rowB], complete: false, durationMs: 800 }));

		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toMatch(/^Stopped early\./);
		expect(tableRows()).toHaveLength(2);
		expect(screen.queryByTestId('upgrades-run-progress')).toBeNull();
	});

	// Nothing the run card shows changes while rows land, so a landed row must not render it again (review K2-4).
	it('does not render the run card again for a row a run lands', () => {
		mount();
		const run = clickRun();
		const rendersWhileRunning = runCard.renders;
		// The counter counts: the card rendered at mount and when the run started.
		expect(rendersWhileRunning).toBeGreaterThan(0);

		act(() => run.deps.onLanded(rowA));
		act(() => run.deps.onLanded(rowB));
		expect(tableRows()).toHaveLength(2);
		expect(runCard.renders).toBe(rendersWhileRunning);
	});

	it('shows the whole ranking and how long it took when the run finishes', async () => {
		mount();
		const run = clickRun();
		await act(async () => run.settle({ ...RANKING_FIXTURE, durationMs: 4200 }));

		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toMatch(/Took 4\.2s\.$/);
		// The Upgrades pane lists the ten rows above the cutoff; the eleventh waits in the collapsed group.
		expect(tableRows()).toHaveLength(10);
		expect(screen.getAllByTestId('upgrades-below-cutoff-trigger')[0]?.textContent).toBe('1 item(s) below the cutoff');
		expect((screen.getByTestId('upgrades-run-button') as HTMLButtonElement).disabled).toBe(false);
	});

	it('runs with the excluded sources, the selected sets and the iterations the column holds', () => {
		mount();
		expect(screen.getByTestId('upgrades-eligible-count').dataset.count).toBe('3');

		fireEvent.click(screen.getByTestId('upgrades-sources-button'));
		const hyjal = screen.getAllByTestId('upgrades-source-row').find(row => row.dataset.source === 'Hyjal Summit');
		if (!hyjal) throw new Error('no Hyjal row');
		fireEvent.click(within(hyjal).getByRole('checkbox'));
		expect(screen.getByTestId('upgrades-eligible-count').dataset.count).toBe('2');
		fireEvent.click(screen.getByTestId('sim-dialog-close'));

		const iterations = within(screen.getByTestId('upgrades-iterations-picker')).getByRole('textbox');
		act(() => {
			fireEvent.change(iterations, { target: { value: '750' } });
		});
		expect((iterations as HTMLInputElement).value).toBe('750');

		expect(clickRun().settings).toEqual({
			iterations: 750,
			candidateCap: undefined,
			excludedSources: ['Hyjal Summit'],
			guaranteedSetKeys: ['preset:3:P3'],
			guaranteedSetItemIds: [1],
			prune: false,
		});
	});

	it('marks a live run with its runner, and shows it current until the gear changes', async () => {
		mount();
		expect(tabRoot().dataset.runner).toBeUndefined();
		const run = clickRun();
		await act(async () => run.settle({ ...RANKING_FIXTURE, durationMs: 4200, runner: 'WorkerPoolSimRunner' }));

		expect(tabRoot().dataset.runner).toBe('WorkerPoolSimRunner');
		expect(screen.queryByTestId('upgrades-stale')).toBeNull();

		act(() => {
			worn = 'P3 preset';
			pageChanged();
		});
		expect(screen.getByTestId('upgrades-stale')).not.toBeNull();
	});

	it('shows a loaded fixture as current with no runner, and as stale once a setting changes', () => {
		mount();
		act(() => autoload.current?.onLoaded(RANKING_FIXTURE));

		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toBe('Your current gear: 2,084.2 DPS.');
		expect(tabRoot().dataset.runner).toBeUndefined();
		expect(screen.queryByTestId('upgrades-stale')).toBeNull();

		const chip = screen.getAllByTestId('upgrades-set-chip').find(element => element.dataset.setKey === 'preset:3:P3');
		if (!chip) throw new Error('no P3 chip');
		fireEvent.click(within(chip).getByRole('button'));
		expect(screen.getByTestId('upgrades-stale')).not.toBeNull();
	});
	it('lets code outside the tab, mounted before it, read the tab’s run state and effective settings', async () => {
		const error = vi.spyOn(console, 'error');
		mount(<Probe />);
		expect(probe('run-status')).toBe('idle');
		expect(probe('set-keys')).toBe('preset:3:P3');
		expect(probe('set-keys')).toBe(tabSetKeys());
		expect(probe('iterations')).toBe('3000');
		expect(probe('iterations')).toBe(tabIterations());

		act(() => patchSlice(current.store, 'sim', { phase: 4 }));
		expect(probe('set-keys')).toBe('preset:4:P4');
		expect(probe('set-keys')).toBe(tabSetKeys());
		// A store written during a render would warn here.
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();

		const run = clickRun();
		expect(probe('run-status')).toBe('running');
		await act(async () => run.settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		expect(probe('run-status')).toBe('done');
	});

	// Development renders mount, unmount and mount again, so the run session is disposed before the first Run.
	it('runs under StrictMode after the development remount', async () => {
		render(
			<StrictMode>
				<SimHostProvider host={current.host}>
					<UpgradesTabBodyInner />
				</SimHostProvider>
			</StrictMode>,
		);
		const run = clickRun();
		const context = run.deps.runContext();
		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toBe(context);

		act(() => run.deps.onLanded(rowA));
		expect(tableRows()).toHaveLength(1);
		await act(async () => run.settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		expect(screen.getByTestId('upgrades-baseline-summary').textContent).toMatch(/Took/);
	});
});

describe('UpgradesTabBody before its tab is first opened', () => {
	// A closed tab's panel carries `hidden`, as Base UI's closed `Tabs.Panel` does; the pane stays mounted.
	it('renders the tab body only once its panel stops being hidden', async () => {
		render(
			<SimHostProvider host={current.host}>
				<div role="tabpanel" hidden data-testid="closed-panel">
					<UpgradesTabBody />
				</div>
			</SimHostProvider>,
		);
		await act(() => new Promise(resolve => setTimeout(resolve, 50)));
		expect(screen.queryByTestId('upgrades-tab-root')).toBeNull();

		act(() => screen.getByTestId('closed-panel').removeAttribute('hidden'));
		expect(await screen.findByTestId('upgrades-tab-root')).not.toBeNull();
	});

	const SAVED_KEY = '__upgrades_test__upgradesSettings__';
	/** The user cleared phase 3's default sets on an earlier visit, so the saved entry holds no sets for `ret:3`. */
	const clearedAt3 = () => memoryStorage({ [SAVED_KEY]: JSON.stringify({ version: 1, settings: { selectedSetKeys: [], defaultsFor: 'ret:3' } }) });
	const renderClosed = () =>
		render(
			<SimHostProvider host={current.host}>
				<div role="tabpanel" hidden data-testid="closed-panel">
					<UpgradesTabBody />
				</div>
			</SimHostProvider>,
		);
	/** Phase 3 to 4 and back on another tab, after the page has started up; each write rings the page's listeners as the real store would. */
	const roundTripThroughPhase4 = async () => {
		await act(settled);
		act(() => {
			patchSlice(current.store, 'sim', { phase: 4 });
			pageChanged();
			patchSlice(current.store, 'sim', { phase: 3 });
			pageChanged();
		});
		await act(settled);
	};

	// Ticket 564: a phase change resets the tab to that phase's defaults whether or not the tab is on screen (ticket 587, A1).
	it('selects the phase’s default sets for a phase change made before the tab opens, even one back to the saved phase', async () => {
		current = makeHost(clearedAt3());
		renderClosed();
		await roundTripThroughPhase4();

		act(() => screen.getByTestId('closed-panel').removeAttribute('hidden'));
		await screen.findByTestId('upgrades-tab-root');
		expect(tabSetKeys()).toBe('preset:3:P3');
	});

	it('saves that reset for the next page load when the tab is never opened', async () => {
		current = makeHost(clearedAt3());
		renderClosed();
		await roundTripThroughPhase4();
		cleanup();

		current = makeHost(current.storage);
		mount();
		expect(tabSetKeys()).toBe('preset:3:P3');
	});
});
