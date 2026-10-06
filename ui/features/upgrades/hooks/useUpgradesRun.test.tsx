import { Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PartialRanking } from '../model/engine/rank';
import type { RunDeps, RunFn } from '../model/run';
import type { RunOutcome, RunResult } from '../model/run_reducer';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';

const contexts: Array<{ terminate: () => void }> = [];
vi.mock('../model/run', async importOriginal => ({
	...(await importOriginal<typeof import('../model/run')>()),
	createRunContext: () => {
		const context = { terminate: vi.fn() };
		contexts.push(context);
		return context;
	},
}));

const { useUpgradesRun } = await import('./useUpgradesRun');

const rowA = fixtureRow(0);
const rowB = fixtureRow(1);
const SETTINGS = { iterations: 500 };
const SIGNATURE = 'page and settings';

/** A run the test drives by hand: it keeps each call's deps and settles when told to. */
const controllableRun = () => {
	const calls: Array<{ deps: RunDeps; settle: (result: RunOutcome) => void; fail: (error: unknown) => void }> = [];
	const runFn: RunFn = (_host, _settings, deps) =>
		new Promise((resolve, reject) => {
			calls.push({ deps, settle: resolve, fail: reject });
		});
	const call = (index: number) => {
		const found = calls[index];
		if (!found) throw new Error(`run ${index} never started`);
		return found;
	};
	return { runFn, call };
};

const partialOf = (rows = [rowA]): RunResult =>
	({ ...RANKING_FIXTURE, items: rows, complete: false, durationMs: 9 }) satisfies PartialRanking & { durationMs: number };

/** The page's gear, which a test changes between a click and a settle. */
let equipped: Array<{ id: number } | null> = [];
const host = fakeHost({ player: { getGear: () => ({ getEquippedItems: () => equipped }), getSpec: () => Spec.SpecRetributionPaladin } });
const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
const mount = (runFn: RunFn) => renderHook(() => useUpgradesRun(runFn), { wrapper });

beforeEach(() => {
	contexts.length = 0;
	equipped = [];
});
afterEach(() => vi.restoreAllMocks());

describe('useUpgradesRun', () => {
	it('runs from idle through landed rows to done', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		expect(result.current.run.status).toBe('idle');

		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [] });

		act(() => call(0).deps.onLanded(rowA));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [rowA] });

		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1200 }));
		expect(result.current.run).toMatchObject({ status: 'done', result: { durationMs: 1200 } });
	});

	it('aborts the run on stop and shows the partial ranking it returns', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));

		act(() => result.current.stop());
		expect(call(0).deps.signal.aborted).toBe(true);
		expect(result.current.run).toMatchObject({ status: 'running', stopping: true });

		await act(async () => call(0).settle(partialOf()));
		expect(result.current.run).toMatchObject({ status: 'stopped', result: { items: [rowA] } });
	});

	it('lets a second start supersede the first, whose late rows and result are dropped', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(call(0).deps.signal.aborted).toBe(true);

		act(() => call(0).deps.onLanded(rowA));
		await act(async () => call(0).settle(partialOf()));
		act(() => call(1).deps.onLanded(rowB));
		expect(result.current.run).toMatchObject({ status: 'running', landedRows: [rowB] });
	});

	it('shows a failed run as an error', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));

		await act(async () => call(0).fail(new Error('worker died')));
		expect(result.current.run).toMatchObject({ status: 'error' });
	});

	it('builds the run context once, on first use, and reuses it across runs', () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(contexts).toHaveLength(0);

		const first = call(0).deps.runContext();
		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(call(1).deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);
	});

	it('builds no context for a run that never asks for one', async () => {
		const { runFn, call } = controllableRun();
		const { result, unmount } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		unmount();

		expect(contexts).toHaveLength(0);
	});

	it('aborts the run and ends the workers on unmount', () => {
		const { runFn, call } = controllableRun();
		const { result, unmount } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		const context = call(0).deps.runContext();

		unmount();
		expect(call(0).deps.signal.aborted).toBe(true);
		expect(context.terminate).toHaveBeenCalledOnce();
	});

	it('shows a loaded fixture as a finished run and drops the run it replaced', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));

		act(() => result.current.dispatchFixture(RANKING_FIXTURE, SIGNATURE));
		expect(call(0).deps.signal.aborted).toBe(true);
		await act(async () => call(0).settle(partialOf()));
		expect(result.current.run).toMatchObject({ status: 'done', runId: 2, result: RANKING_FIXTURE });
	});

	it('keeps the gear a run started on, not the gear worn when it settles (ticket 536)', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		equipped = [{ id: 30990 }, null];
		act(() => result.current.start(SETTINGS, SIGNATURE));
		equipped = [{ id: 1 }];

		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		const worn = [30990, ...Array.from({ length: 16 }, () => 0)];
		expect(result.current.run).toMatchObject({ status: 'done', measuredOn: { wornItemIds: worn, specId: 'ret' } });
	});

	it('keeps the gear a fixture was loaded with', () => {
		const { runFn } = controllableRun();
		const { result } = mount(runFn);
		equipped = [{ id: 28830 }];

		act(() => result.current.dispatchFixture(RANKING_FIXTURE, SIGNATURE));
		expect(result.current.run).toMatchObject({
			status: 'done',
			measuredOn: { wornItemIds: [28830, ...Array.from({ length: 16 }, () => 0)], specId: 'ret' },
		});
	});

	it('keeps the inputs signature the caller passed at the click and the runner the run named', async () => {
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, 'sig-at-click'));
		expect(result.current.run).toMatchObject({ status: 'running', measuredOn: { inputsSignature: 'sig-at-click' } });

		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1, runner: 'WorkerPoolSimRunner' }));
		expect(result.current.run).toMatchObject({ status: 'done', measuredOn: { inputsSignature: 'sig-at-click', runner: 'WorkerPoolSimRunner' } });
	});

	it('keeps the inputs signature passed with a fixture, and names no runner', () => {
		const { runFn } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.dispatchFixture(RANKING_FIXTURE, 'sig-at-load'));
		expect(result.current.run).toMatchObject({ status: 'done', measuredOn: { inputsSignature: 'sig-at-load' } });
		expect(result.current.run.status === 'done' && result.current.run.measuredOn?.runner).toBeUndefined();
	});

	it('logs the run’s assumptions once when it settles, with the full text of each reason the page shortens', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		expect(info).not.toHaveBeenCalled();

		await act(async () => call(0).settle({ ...RANKING_FIXTURE, durationMs: 1 }));
		expect(info).toHaveBeenCalledTimes(1);
		expect(info.mock.calls[0]?.[0]).toMatch(
			/^\[upgrades\] assumptions — seeds: 11, 22, 33, 44, 55 · iterations: 3000 · max phase: 3 · candidate pool: every eligible item/,
		);
		expect(warn.mock.calls).toEqual([[expect.stringMatching(/^\[upgrades\] candidate 32837 \(mainhand\): Warglaive of Azzinoth .*\ngoroutine 1/s)]]);
	});

	it('logs nothing for a run a newer one superseded, and logs a loaded fixture once', async () => {
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { runFn, call } = controllableRun();
		const { result } = mount(runFn);
		act(() => result.current.start(SETTINGS, SIGNATURE));
		act(() => result.current.dispatchFixture(RANKING_FIXTURE, SIGNATURE));
		expect(info).toHaveBeenCalledTimes(1);

		await act(async () => call(0).settle(partialOf()));
		expect(info).toHaveBeenCalledTimes(1);
	});
});
