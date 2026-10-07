import { Raid as RaidProto } from '@generated/proto/api';
import { Encounter as EncounterProto, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { createSimStore, patchKeyed, patchSlice, PLAYER_FIELDS, type PlayerSlice, seedKeyed, zeroVersions } from '@sim/state/sim_store';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inputsSignature, liveInputsKey } from '../model/run_inputs';
import type { RunOutcome, RunSettings } from '../model/run_reducer';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';

vi.mock('../model/run', async importOriginal => ({
	...(await importOriginal<typeof import('../model/run')>()),
	createRunContext: () => ({ terminate: () => {} }),
}));

const { useRunStale } = await import('./useRunStale');
const { useUpgradesRun } = await import('./useUpgradesRun');
const { selectRunStatus, useUpgradesStore } = await import('./useUpgradesStore');

/** The page the key reads: one player's raid proto, which a test edits. */
let raidName = 'worn gear A';
const SETTINGS: RunSettings = { iterations: 500, excludedSources: [], guaranteedSetKeys: [], guaranteedSetItemIds: [], prune: false };
const PLAYER_KEY = 1;

/**
 * A fresh page per case, so each case gets its own tab store (the store is keyed by the page's `Sim`).
 * The page's sim store and its subscriptions are real, so an edit notifies the hook only if upstream's
 * `subscribeSimChange` selector sees it; the protos the key reads are stand-ins.
 */
const makePage = () => {
	const store = createSimStore();
	// The selector watches a raid member's version counters, not the slice's values.
	seedKeyed(store, 'players', PLAYER_KEY, { v: zeroVersions(PLAYER_FIELDS) } as PlayerSlice);
	patchSlice(store, 'raid', { composition: [[PLAYER_KEY]] });
	const sim = {
		store,
		raid: { toProto: () => RaidProto.create({ parties: [{ players: [{ name: raidName }] }] }) },
		encounter: { toProto: () => EncounterProto.create({ duration: 180 }) },
		getPhase: () => 3,
	};
	const host = fakeHost({
		sim,
		player: { getGear: () => ({ getEquippedItems: () => [] }), getSpec: () => Spec.SpecRetributionPaladin },
	});
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	const signatureNow = (settings: RunSettings) => inputsSignature({ liveKey: liveInputsKey(sim), settings });
	/** A gear edit, written to the store the way a gear setter writes it. */
	const changeGear = () => {
		raidName = 'worn gear B';
		patchKeyed(store, 'players', PLAYER_KEY, {}, ['gear']);
	};
	/** A page edit the run does not read. */
	const changeSeed = () => patchSlice(store, 'sim', { fixedRngSeed: 7 });
	return { wrapper, signatureNow, changeGear, changeSeed };
};

/** The tab's run and its staleness, with a run the test settles by hand. */
const mountRun = () => {
	const { wrapper, ...page } = makePage();
	let settle: (outcome: RunOutcome) => void = () => {};
	const runFn = () => new Promise<RunOutcome>(resolve => (settle = resolve));
	const view = renderHook(({ settings }) => ({ ...useUpgradesRun(runFn), status: useUpgradesStore(selectRunStatus), stale: useRunStale(settings) }), {
		wrapper,
		initialProps: { settings: SETTINGS },
	});
	return { view, ...page, settle: (outcome: RunOutcome) => settle(outcome) };
};

beforeEach(() => {
	raidName = 'worn gear A';
});

describe('useRunStale', () => {
	it('shows a fresh run as current, and as stale once the gear changes', async () => {
		const { view, settle, signatureNow, changeGear } = mountRun();
		act(() => view.result.current.start(SETTINGS, signatureNow(SETTINGS)));
		expect(view.result.current.stale).toBe(false);

		await act(async () => settle({ ...RANKING_FIXTURE, durationMs: 10 }));
		expect(view.result.current.status).toBe('done');
		expect(view.result.current.stale).toBe(false);

		act(changeGear);
		expect(view.result.current.stale).toBe(true);
	});

	it('shows a fresh fixture as current, and as stale once the gear changes', () => {
		const { view, signatureNow, changeGear } = mountRun();
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));
		expect(view.result.current.stale).toBe(false);

		act(changeGear);
		expect(view.result.current.stale).toBe(true);
	});

	it('marks a result stale when a tab setting or the iterations change', () => {
		const { view, signatureNow } = mountRun();
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));

		view.rerender({ settings: { ...SETTINGS, excludedSources: ['Black Temple'] } });
		expect(view.result.current.stale).toBe(true);
		view.rerender({ settings: { ...SETTINGS, iterations: 2000 } });
		expect(view.result.current.stale).toBe(true);
		view.rerender({ settings: SETTINGS });
		expect(view.result.current.stale).toBe(false);
	});

	it('keeps a result current through an edit the run does not read, and a render with the same settings', () => {
		const { view, signatureNow, changeSeed } = mountRun();
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));

		// A fixed seed notifies, but leaves raid, encounter and phase alone.
		act(changeSeed);
		view.rerender({ settings: { ...SETTINGS } });
		expect(view.result.current.stale).toBe(false);
	});

	it('is never stale while running', () => {
		const { view } = mountRun();
		act(() => view.result.current.start(SETTINGS, 'an older page'));
		expect(view.result.current.stale).toBe(false);
	});

	// Every render counts: a page key cached from before the result would show the warning for one paint.
	it('never renders a fresh result as stale, though the gear changed after the tab mounted', () => {
		const { wrapper, signatureNow, changeGear } = makePage();
		const seen: boolean[] = [];
		const view = renderHook(
			() => {
				const tab = useUpgradesRun(() => new Promise<RunOutcome>(() => {}));
				seen.push(useRunStale(SETTINGS));
				return tab;
			},
			{ wrapper },
		);
		act(changeGear);
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));
		expect(seen).not.toContain(true);
	});
});
