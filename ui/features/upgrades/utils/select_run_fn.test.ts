import { afterEach, describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';

// The live run pulls in the engine and its data; this test only needs to tell it apart.
const rankForPlayer = vi.fn();
vi.mock('../model/run', () => ({ rankForPlayer, specIdFor: () => 'ret' }));

/** `FIXTURES_ENABLED` is read once at module load, so each switch value needs a fresh module graph. */
const importModules = async (enabled: boolean) => {
	vi.resetModules();
	vi.stubEnv('DEV', enabled);
	vi.stubEnv('VITE_TBC_TAB_FIXTURES', '');
	const { selectRunFn } = await import('./select_run_fn');
	return selectRunFn;
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe('selectRunFn', () => {
	it('ranks the live page when no replay is asked for', async () => {
		const selectRunFn = await importModules(true);
		expect(selectRunFn({})).toBe(rankForPlayer);
	});

	it('ranks the live page on a production build, whatever the flags say', async () => {
		const selectRunFn = await importModules(false);
		expect(selectRunFn({ replay: 'ret-p3-p2' })).toBe(rankForPlayer);
	});

	it('replays the named fixture on a dev build, fetching it only when the run starts', async () => {
		const selectRunFn = await importModules(true);
		const fixture = { schemaVersion: 1, forkSha: 'x', spec: 'ret', phase: 2, gear: {}, recordedAt: 'now', iterations: 1, ranking: RANKING_FIXTURE };
		const fetchStub = vi.fn(async () => new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } }));
		vi.stubGlobal('fetch', fetchStub);

		const runFn = selectRunFn({ replay: 'ret-p3-p2' });
		expect(runFn).not.toBe(rankForPlayer);
		expect(fetchStub).not.toHaveBeenCalled();

		const landed: number[] = [];
		const runContext = vi.fn();
		const host = { player: {} } as Parameters<typeof runFn>[0];
		const result = await runFn(host, { iterations: 1 }, { signal: new AbortController().signal, onLanded: row => landed.push(row.itemId), runContext });

		expect(fetchStub).toHaveBeenCalledWith('/tbc/tab-fixtures/ret-p3-p2.json');
		expect(landed).toEqual(RANKING_FIXTURE.items.map(row => row.itemId));
		expect(result).toMatchObject({ complete: true });
		expect(runContext).not.toHaveBeenCalled();
	});
});
