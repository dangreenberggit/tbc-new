import { Raid as RaidProto } from '@generated/proto/api';
import { Encounter as EncounterProto, Spec } from '@generated/proto/common';
import { SimHostProvider } from '@sim/context/SimHostContext';
import { fakeHost } from '@sim/testing';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inputsSignature, liveInputsKey } from '../model/run_inputs';
import type { RunOutcome, RunSettings } from '../model/run_reducer';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';

/** The page's change source: every listener hears every page edit. */
const listeners = new Set<() => void>();
const pageChanged = () => listeners.forEach(listener => listener());
vi.mock('@sim/state/subscriptions', async () =>
	(await import('@sim/testing')).mockSubscriptions(listener => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}),
);
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

/** A fresh page per case, so each case gets its own tab store (the store is keyed by the page's `Sim`). */
const makePage = () => {
	const sim = {
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
	return { wrapper, signatureNow };
};

/** The tab's run and its staleness, with a run the test settles by hand. */
const mountRun = () => {
	const { wrapper, signatureNow } = makePage();
	let settle: (outcome: RunOutcome) => void = () => {};
	const runFn = () => new Promise<RunOutcome>(resolve => (settle = resolve));
	const view = renderHook(({ settings }) => ({ ...useUpgradesRun(runFn), status: useUpgradesStore(selectRunStatus), stale: useRunStale(settings) }), {
		wrapper,
		initialProps: { settings: SETTINGS },
	});
	return { view, signatureNow, settle: (outcome: RunOutcome) => settle(outcome) };
};

beforeEach(() => {
	raidName = 'worn gear A';
	listeners.clear();
});

describe('useRunStale', () => {
	it('shows a fresh run as current, and as stale once the gear changes', async () => {
		const { view, settle, signatureNow } = mountRun();
		act(() => view.result.current.start(SETTINGS, signatureNow(SETTINGS)));
		expect(view.result.current.stale).toBe(false);

		await act(async () => settle({ ...RANKING_FIXTURE, durationMs: 10 }));
		expect(view.result.current.status).toBe('done');
		expect(view.result.current.stale).toBe(false);

		act(() => {
			raidName = 'worn gear B';
			pageChanged();
		});
		expect(view.result.current.stale).toBe(true);
	});

	it('shows a fresh fixture as current, and as stale once the gear changes', () => {
		const { view, signatureNow } = mountRun();
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));
		expect(view.result.current.stale).toBe(false);

		act(() => {
			raidName = 'worn gear B';
			pageChanged();
		});
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
		const { view, signatureNow } = mountRun();
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));

		// A fixed seed or a display toggle notifies, but leaves raid, encounter and phase alone.
		act(() => pageChanged());
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
		const { wrapper, signatureNow } = makePage();
		const seen: boolean[] = [];
		const view = renderHook(
			() => {
				const tab = useUpgradesRun(() => new Promise<RunOutcome>(() => {}));
				seen.push(useRunStale(SETTINGS));
				return tab;
			},
			{ wrapper },
		);
		act(() => {
			raidName = 'worn gear B';
			pageChanged();
		});
		act(() => view.result.current.loadFixture(RANKING_FIXTURE, signatureNow(SETTINGS)));
		expect(seen).not.toContain(true);
	});
});
