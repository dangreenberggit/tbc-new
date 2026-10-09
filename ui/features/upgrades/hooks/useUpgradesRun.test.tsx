import { Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore } from '@sim/state/sim_store';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDeps, RunFn } from '../model/run';
import type { RunOutcome } from '../model/run_reducer';
import { fakeTabHost } from '../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';

const contexts: Array<object> = [];
vi.mock('../model/run', async importOriginal => ({
	...(await importOriginal<typeof import('../model/run')>()),
	createRunContext: () => {
		const context = {};
		contexts.push(context);
		return context;
	},
}));

const { useUpgradesRun } = await import('./useUpgradesRun');
const { upgradesStoreFor } = await import('./useUpgradesStore');

const rowA = fixtureRow(0);
const SETTINGS = { iterations: 500 };
const SIGNATURE = 'page and settings';

/** A run the test drives by hand: it keeps each call's deps and settles when told to. */
const controllableRun = () => {
	const calls: Array<{ deps: RunDeps; settle: (result: RunOutcome) => void }> = [];
	const runFn: RunFn = (_host, _settings, deps) => new Promise(resolve => calls.push({ deps, settle: resolve }));
	const call = (index: number) => {
		const found = calls[index];
		if (!found) throw new Error(`run ${index} never started`);
		return found;
	};
	return { runFn, call };
};

/** A fresh page per case, so each case gets its own tab store (the store is keyed by the page's `Sim`). */
const mount = (runFn: RunFn) => {
	const host = fakeTabHost({
		player: { getGear: () => ({ getEquippedItems: () => [] }), getSpec: () => Spec.SpecRetributionPaladin },
		sim: { store: createSimStore() },
	});
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	const view = renderHook(() => useUpgradesRun(runFn), { wrapper });
	return { ...view, run: () => upgradesStoreFor(host).getState().run };
};

beforeEach(() => {
	contexts.length = 0;
});

// The session's own behaviour is `model/run_session.test.ts`; this is the hook's wiring to the page's store.
describe('useUpgradesRun', () => {
	it('runs into the page’s tab store, from idle through landed rows to done', async () => {
		const { runFn, call } = controllableRun();
		const { result, run } = mount(runFn);
		expect(run().status).toBe('idle');

		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(run()).toMatchObject({ status: 'running', landedRows: [] });

		act(() => call(0).deps.onLanded(rowA));
		expect(run()).toMatchObject({ status: 'running', landedRows: [rowA] });

		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1200 }));
		expect(run()).toMatchObject({ status: 'done', result: { durationMs: 1200 } });
	});

	it('keeps one session across renders, so a later run reuses the workers and supersedes the earlier one', () => {
		const { runFn, call } = controllableRun();
		const { result, rerender } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		const first = call(0).deps.runContext();

		rerender();
		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(call(0).deps.signal.aborted).toBe(true);
		expect(call(1).deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);
	});

	it('stops the run in flight', () => {
		const { runFn, call } = controllableRun();
		const { result, run } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));

		act(() => result.current.stop());
		expect(call(0).deps.signal.aborted).toBe(true);
		expect(run()).toMatchObject({ status: 'running', stopping: true });
	});

	it('shows a loaded fixture as a finished run', () => {
		const { runFn } = controllableRun();
		const { result, run } = mount(runFn);
		act(() => result.current.loadFixture(RANKING_FIXTURE, SIGNATURE));
		expect(run()).toMatchObject({ status: 'done', result: RANKING_FIXTURE, measuredOn: { inputsSignature: SIGNATURE } });
	});

	it('aborts the run on unmount', () => {
		const { runFn, call } = controllableRun();
		const { result, unmount } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		call(0).deps.runContext();

		unmount();
		expect(call(0).deps.signal.aborted).toBe(true);
	});
});
