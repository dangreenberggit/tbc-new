import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PartialRanking } from '../model/engine/rank';
import type { RunContext, RunDeps, RunFn } from '../model/run';
import type { RunResult } from '../model/run_reducer';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';

const contexts: RunContext[] = [];
vi.mock('../model/run', async importOriginal => ({
	...(await importOriginal<typeof import('../model/run')>()),
	createRunContext: () => {
		const context = { terminate: vi.fn() } as unknown as RunContext;
		contexts.push(context);
		return context;
	},
}));

const { useUpgradesRun } = await import('./useUpgradesRun');

const [rowA, rowB] = RANKING_FIXTURE.items;
const SETTINGS = { iterations: 500 };

/** A run the test drives by hand: it keeps each call's deps and settles when told to. */
const controllableRun = () => {
	const calls: Array<{ deps: RunDeps; settle: (result: RunResult) => void; fail: (error: unknown) => void }> = [];
	const runFn: RunFn = (_host, _settings, deps) =>
		new Promise((resolve, reject) => {
			calls.push({ deps, settle: resolve, fail: reject });
		});
	return { runFn, calls };
};

const partialOf = (rows = [rowA!]): RunResult =>
	({ ...RANKING_FIXTURE, items: rows, complete: false, durationMs: 9 }) satisfies PartialRanking & { durationMs: number };

const host = fakeHost();
const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
const mount = (runFn: RunFn) => renderHook(() => useUpgradesRun(runFn), { wrapper });

beforeEach(() => {
	contexts.length = 0;
});

describe('useUpgradesRun', () => {
	it('runs from idle through landed rows to done', async () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		expect(result.current.run.status).toBe('idle');

		act(() => result.current.start(SETTINGS));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [] });

		act(() => calls[0]!.deps.onLanded(rowA!));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [rowA] });

		await act(async () => calls[0]!.settle({ ...RANKING_FIXTURE, durationMs: 1200 }));
		expect(result.current.run).toMatchObject({ status: 'done', result: { durationMs: 1200 } });
	});

	it('aborts the run on stop and shows the partial ranking it returns', async () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS));

		act(() => result.current.stop());
		expect(calls[0]!.deps.signal.aborted).toBe(true);

		await act(async () => calls[0]!.settle(partialOf()));
		expect(result.current.run).toMatchObject({ status: 'stopped', result: { items: [rowA] } });
	});

	it('lets a second start supersede the first, whose late rows and result are dropped', async () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS));
		act(() => result.current.start(SETTINGS));
		expect(calls[0]!.deps.signal.aborted).toBe(true);

		act(() => calls[0]!.deps.onLanded(rowA!));
		await act(async () => calls[0]!.settle(partialOf()));
		act(() => calls[1]!.deps.onLanded(rowB!));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [rowB] });
	});

	it('shows a failed run as an error', async () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS));

		await act(async () => calls[0]!.fail(new Error('worker died')));
		expect(result.current.run).toMatchObject({ status: 'error' });
	});

	it('builds the run context once, on first use, and reuses it across runs', () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS));
		expect(contexts).toHaveLength(0);

		const first = calls[0]!.deps.runContext();
		act(() => result.current.start(SETTINGS));
		expect(calls[1]!.deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);
	});

	it('builds no context for a run that never asks for one', async () => {
		const { runFn, calls } = controllableRun();
		const { result, unmount } = mount(runFn);
		act(() => result.current.start(SETTINGS));
		await act(async () => calls[0]!.settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		unmount();

		expect(contexts).toHaveLength(0);
	});

	it('aborts the run and ends the workers on unmount', () => {
		const { runFn, calls } = controllableRun();
		const { result, unmount } = mount(runFn);
		act(() => result.current.start(SETTINGS));
		const context = calls[0]!.deps.runContext();

		unmount();
		expect(calls[0]!.deps.signal.aborted).toBe(true);
		expect(context.terminate).toHaveBeenCalledOnce();
	});

	it('shows a loaded fixture as a finished run and drops the run it replaced', async () => {
		const { runFn, calls } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS));

		act(() => result.current.dispatchFixture(RANKING_FIXTURE));
		expect(calls[0]!.deps.signal.aborted).toBe(true);
		await act(async () => calls[0]!.settle(partialOf()));
		expect(result.current.run).toMatchObject({ status: 'done', result: { durationMs: 0 } });
	});
});
