import { Spec } from '@generated/proto/common';
import { fakeHost } from '@sim/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settled } from '../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { RunnerEnv } from './adapters/worker_pool_sim_runner';
import type { PartialRanking } from './engine/rank';
import type { RunDeps, RunFn } from './run';
import type { RunOutcome, RunResult } from './run_reducer';
import { createUpgradesStore } from './upgrades_store';

const contexts: Array<object> = [];
vi.mock('./run', async importOriginal => ({
	...(await importOriginal<typeof import('./run')>()),
	createRunContext: () => {
		const context = {};
		contexts.push(context);
		return context;
	},
}));

const { createRunSession } = await import('./run_session');

const rowA = fixtureRow(0);
const rowB = fixtureRow(1);
const SETTINGS = { iterations: 500 };
const SIGNATURE = 'page and settings';
const ENV = { runner: {} as RunnerEnv, describeError: (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}` };

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

/** Lets every promise callback already queued run, so a dropped result has had its chance to land. */

/** The page's gear, which a test changes between a click and a settle. */
let equipped: Array<{ id: number } | null> = [];

const setup = (store = createUpgradesStore({ iterations: 3000 })) => {
	const { runFn, call } = controllableRun();
	const host = fakeHost({ player: { getGear: () => ({ getEquippedItems: () => equipped }), getSpec: () => Spec.SpecRetributionPaladin } });
	const session = createRunSession(store, host, runFn, ENV);
	return { store, session, call, run: () => store.getState().run };
};

beforeEach(() => {
	contexts.length = 0;
	equipped = [];
	vi.spyOn(console, 'info').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createRunSession', () => {
	it('runs from idle through landed rows to done, keeping the gear and signature of the click', async () => {
		const { session, call, run } = setup();
		equipped = [{ id: 30990 }, null];
		session.start(SETTINGS, SIGNATURE);
		equipped = [{ id: 1 }];
		const worn = [30990, ...Array.from({ length: 16 }, () => 0)];
		expect(run()).toMatchObject({ status: 'running', landedRows: [], measuredOn: { wornItemIds: worn, specId: 'ret', inputsSignature: SIGNATURE } });

		call(0).deps.onLanded(rowA);
		expect(run()).toMatchObject({ status: 'running', landedRows: [rowA] });

		call(0).settle({ ...RANKING_FIXTURE, durationMs: 1200, runner: 'WorkerPoolSimRunner' });
		await vi.waitFor(() => expect(run().status).toBe('done'));
		expect(run()).toMatchObject({ result: { durationMs: 1200 }, measuredOn: { wornItemIds: worn, runner: 'WorkerPoolSimRunner' } });
		expect(console.info).toHaveBeenCalledOnce();
	});

	it('aborts the run on stop and shows the partial ranking it returns', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE);

		session.stop();
		expect(call(0).deps.signal.aborted).toBe(true);
		expect(run()).toMatchObject({ status: 'running', stopping: true });

		call(0).settle(partialOf());
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'stopped', result: { items: [rowA] } }));
	});

	it('does nothing on stop when no run was started', () => {
		const { session, run } = setup();
		session.stop();
		expect(run().status).toBe('idle');
	});

	it('drops a superseded run’s late rows and result, and does not log it', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE);
		session.start(SETTINGS, SIGNATURE);
		expect(call(0).deps.signal.aborted).toBe(true);

		call(0).deps.onLanded(rowA);
		call(0).settle(partialOf());
		await settled();
		call(1).deps.onLanded(rowB);
		expect(run()).toMatchObject({ status: 'running', runId: 2, landedRows: [rowB] });
		expect(console.info).not.toHaveBeenCalled();
	});

	it('shows a failed run as an error in the words the caller gave', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE);

		call(0).fail(new Error('worker died'));
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'error', message: 'failed: worker died' }));
	});

	it('shows a loaded fixture as a finished run, aborts the run it replaced and logs the fixture once', async () => {
		const { session, call, run } = setup();
		equipped = [{ id: 28830 }];
		session.start(SETTINGS, SIGNATURE);

		session.loadFixture(RANKING_FIXTURE, 'sig-at-load');
		expect(call(0).deps.signal.aborted).toBe(true);
		call(0).settle(partialOf());
		await settled();
		expect(run()).toMatchObject({
			status: 'done',
			runId: 2,
			result: RANKING_FIXTURE,
			measuredOn: { wornItemIds: [28830, ...Array.from({ length: 16 }, () => 0)], specId: 'ret', inputsSignature: 'sig-at-load' },
		});
		expect(console.info).toHaveBeenCalledOnce();
	});

	it('builds the run context once, on first use, and reuses it across runs', () => {
		const { session, call } = setup();
		session.start(SETTINGS, SIGNATURE);
		expect(contexts).toHaveLength(0);

		const first = call(0).deps.runContext();
		session.start(SETTINGS, SIGNATURE);
		expect(call(1).deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);
	});

	it('aborts the run on dispose', () => {
		const { session, call } = setup();
		session.start(SETTINGS, SIGNATURE);
		call(0).deps.runContext();

		session.dispose();
		expect(call(0).deps.signal.aborted).toBe(true);
	});

	it('runs again after dispose, with the same run context and the run id counting on (StrictMode remount)', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE);
		const first = call(0).deps.runContext();
		session.dispose();

		session.start(SETTINGS, SIGNATURE);
		expect(run()).toMatchObject({ status: 'running', runId: 2 });
		expect(call(1).deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);

		call(1).deps.onLanded(rowA);
		expect(run()).toMatchObject({ landedRows: [rowA] });
		call(1).settle({ ...RANKING_FIXTURE, durationMs: 1 });
		await vi.waitFor(() => expect(run().status).toBe('done'));
	});

	it('continues the store’s run ids in a new session, so an older session’s late row is dropped (remount mid-run)', () => {
		const first = setup();
		first.session.start(SETTINGS, SIGNATURE);
		first.session.dispose();

		const second = setup(first.store);
		second.session.start(SETTINGS, SIGNATURE);
		first.call(0).deps.onLanded(rowA);
		expect(second.run()).toMatchObject({ status: 'running', runId: 2, landedRows: [] });

		second.call(0).deps.onLanded(rowB);
		expect(second.run()).toMatchObject({ status: 'running', runId: 2, landedRows: [rowB] });
	});
});
