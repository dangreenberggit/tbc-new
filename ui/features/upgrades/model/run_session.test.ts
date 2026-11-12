import { Spec } from '@generated/proto/common';
import { fakeHost } from '@sim/testing';
import { toastManager } from '@ui-kit/Toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbPoolHost } from '../testing/db_pool';
import { settled } from '../testing/fake_tab_host';
import { fixtureRow, RANKING_FIXTURE } from '../testing/ranking_fixture';
import type { RunnerEnv } from './adapters/worker_pool_sim_runner';
import { candidateSkipSubstitution, hitCapUnknownNote, type PartialRanking, RankError, SET_BONUS_SKIP_REASONS, setBonusSkipSubstitution } from './engine/rank';
import type { RunDeps, RunFn } from './run';
import type { RunOutcome, RunResult } from './run_state';
import type { SetOption } from './settings_pool';
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

/** The page's gear, which a test changes between a click and a settle. */
let equipped: Array<{ id: number } | null> = [];

const setup = (store = createUpgradesStore({ iterations: 3000 })) => {
	const { runFn, call } = controllableRun();
	const host = fakeHost({
		player: { getGear: () => ({ getEquippedItems: () => equipped }), getSpec: () => Spec.SpecRetributionPaladin, getTalentTreePoints: () => [] },
	});
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
		session.start(SETTINGS, SIGNATURE, []);
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

	it('keeps the sets picked at the click and at a fixture load through a later phase change (ticket 865)', async () => {
		const { store, session, call, run } = setup();
		const p3: SetOption = { key: 'preset:3:P3', name: 'P3', label: 'P3', phase: 3, kind: 'preset', itemIds: [32332], inPool: 1 };
		session.start(SETTINGS, SIGNATURE, [p3]);
		call(0).settle({ ...RANKING_FIXTURE, durationMs: 1200 });
		await vi.waitFor(() => expect(run().status).toBe('done'));
		store.getState().changeScope([]);
		expect(store.getState().settings.selectedSetKeys).toEqual([]);
		expect(run()).toMatchObject({ measuredOn: { selectedSets: [p3] } });

		session.loadFixture(RANKING_FIXTURE, SIGNATURE, [p3]);
		store.getState().changeScope([]);
		expect(run()).toMatchObject({ status: 'done', measuredOn: { selectedSets: [p3] } });
	});

	it('aborts the run on stop and shows the partial ranking it returns', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE, []);

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
		session.start(SETTINGS, SIGNATURE, []);
		session.start(SETTINGS, SIGNATURE, []);
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
		session.start(SETTINGS, SIGNATURE, []);

		call(0).fail(new Error('worker died'));
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'error', message: 'failed: worker died' }));
	});

	// Ticket 868, as wowsims' bulk sim shows a failed run (`ui/features/bulk/model/run.ts:301-310` at 24606be6).
	it("sends a failed run's whole error to the console and its own message to one error toast", async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const toast = vi.spyOn(toastManager, 'add');
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE, []);

		const error = new Error('sim error (ErrorOutcome): panic\nStack Trace:\ngoroutine 7 [running]:');
		call(0).fail(error);
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'error' }));
		expect(consoleError).toHaveBeenCalledWith('[upgrades] the run failed', error);
		expect(toast.mock.calls).toEqual([[{ variant: 'error', body: error.message }]]);
	});

	it('shows no toast for a failed run that was stopped or superseded', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const toast = vi.spyOn(toastManager, 'add');
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE, []);
		session.stop();
		call(0).fail(new Error('refused after Stop'));
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'error' }));

		session.start(SETTINGS, SIGNATURE, []);
		session.start(SETTINGS, SIGNATURE, []);
		call(1).fail(new Error('superseded'));
		await settled();
		expect(toast).not.toHaveBeenCalled();
	});

	// Review A2 of `fix/867-870-tab-errors`: on a spec with no Upgrades data the status line already says so in the
	// tab's words, and the error is the tab's own, not a sim's, so the wowsims precedent for a toast does not apply.
	it('shows no toast for a run on a spec with no Upgrades data', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const toast = vi.spyOn(toastManager, 'add');
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE, []);
		call(0).fail(new RankError('not-implemented', 'no Upgrades data for spec SpecProtectionWarrior'));
		await vi.waitFor(() => expect(run()).toMatchObject({ status: 'error' }));
		expect(toast).not.toHaveBeenCalled();
	});

	// Ticket 874, owner's ruling 2026-11-11: the run goes on past a failed sim, and its end shows one toast, not one per
	// failure, with the first failure's own message as wowsims' bulk sim shows its one failure (`run.ts:301-310`).
	describe('a run that ends with failed sims', () => {
		const setBonus = { setName: 'Justicar Battlegear', threshold: 4 as const };
		const failures = [
			candidateSkipSubstitution({
				kind: 'repair',
				itemId: 32461,
				name: 'Furious Gizmatic Goggles',
				slot: 'head',
				reason: 'no gem layout activates meta 32409',
			}),
			setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.metaOff('no gem layout activates meta 32409') }),
			hitCapUnknownNote(),
			setBonusSkipSubstitution({ ...setBonus, reason: SET_BONUS_SKIP_REASONS.simFailed('HTTP 500 from /raidSimAsync: first\nStack Trace:') }),
			candidateSkipSubstitution({ kind: 'sim', itemId: 29283, name: 'Violet Signet of the Master Assassin', slot: 'finger1', reason: 'worker died' }),
		];
		const ranking = (substitutions: RunResult['substitutions']) => ({ ...RANKING_FIXTURE, substitutions, durationMs: 9 });

		it("shows one error toast with the first failed call's own message, in the notes list's order", async () => {
			const toast = vi.spyOn(toastManager, 'add');
			const { session, call, run } = setup();
			session.start(SETTINGS, SIGNATURE, []);
			call(0).settle(ranking(failures));
			await vi.waitFor(() => expect(run().status).toBe('done'));
			expect(toast.mock.calls).toEqual([[{ variant: 'error', body: 'HTTP 500 from /raidSimAsync: first\nStack Trace:' }]]);
		});

		it('shows no toast when no call failed, after Stop, for a superseded run or for a loaded fixture', async () => {
			const toast = vi.spyOn(toastManager, 'add');
			const { session, call, run } = setup();
			session.start(SETTINGS, SIGNATURE, []);
			call(0).settle(ranking(failures.slice(0, 3)));
			await vi.waitFor(() => expect(run().status).toBe('done'));

			session.start(SETTINGS, SIGNATURE, []);
			session.stop();
			call(1).settle({ ...partialOf(), substitutions: failures });
			await vi.waitFor(() => expect(run().status).toBe('stopped'));

			session.start(SETTINGS, SIGNATURE, []);
			session.start(SETTINGS, SIGNATURE, []);
			call(2).settle(ranking(failures));
			session.loadFixture(ranking(failures), SIGNATURE, []);
			await settled();
			expect(toast).not.toHaveBeenCalled();
		});
	});

	it('shows a loaded fixture as a finished run, aborts the run it replaced and logs the fixture once', async () => {
		const { session, call, run } = setup();
		equipped = [{ id: 28830 }];
		session.start(SETTINGS, SIGNATURE, []);

		session.loadFixture(RANKING_FIXTURE, 'sig-at-load', []);
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

	it('logs the pool lines of the page the run drew from, for a run and for a loaded fixture', async () => {
		const page = dbPoolHost('ret');
		const player = {
			...page.player,
			getGear: () => ({ getEquippedItems: () => equipped }),
			getSpec: () => Spec.SpecRetributionPaladin,
			getTalentTreePoints: () => [],
		};
		const host = fakeHost({ sim: page.sim, individualConfig: page.individualConfig, player } as Parameters<typeof fakeHost>[0]);
		const { runFn, call } = controllableRun();
		const session = createRunSession(createUpgradesStore({ iterations: 3000 }), host, runFn, ENV);

		session.start(SETTINGS, SIGNATURE, []);
		call(0).settle({ ...RANKING_FIXTURE, durationMs: 1200, runner: 'WorkerPoolSimRunner' });
		await vi.waitFor(() => expect(console.info).toHaveBeenCalledOnce());
		session.loadFixture(RANKING_FIXTURE, SIGNATURE, []);

		const lines = vi.mocked(console.info).mock.calls.map(([line]) => String(line));
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).toMatch(/pool source: wowsims db \(\d+ entries\)/);
	});

	it('builds the run context once, on first use, and reuses it across runs', () => {
		const { session, call } = setup();
		session.start(SETTINGS, SIGNATURE, []);
		expect(contexts).toHaveLength(0);

		const first = call(0).deps.runContext();
		session.start(SETTINGS, SIGNATURE, []);
		expect(call(1).deps.runContext()).toBe(first);
		expect(contexts).toHaveLength(1);
	});

	it('aborts the run on dispose', () => {
		const { session, call } = setup();
		session.start(SETTINGS, SIGNATURE, []);
		call(0).deps.runContext();

		session.dispose();
		expect(call(0).deps.signal.aborted).toBe(true);
	});

	it('runs again after dispose, with the same run context and the run id counting on (StrictMode remount)', async () => {
		const { session, call, run } = setup();
		session.start(SETTINGS, SIGNATURE, []);
		const first = call(0).deps.runContext();
		session.dispose();

		session.start(SETTINGS, SIGNATURE, []);
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
		first.session.start(SETTINGS, SIGNATURE, []);
		first.session.dispose();

		const second = setup(first.store);
		second.session.start(SETTINGS, SIGNATURE, []);
		first.call(0).deps.onLanded(rowA);
		expect(second.run()).toMatchObject({ status: 'running', runId: 2, landedRows: [] });

		second.call(0).deps.onLanded(rowB);
		expect(second.run()).toMatchObject({ status: 'running', runId: 2, landedRows: [rowB] });
	});
});
