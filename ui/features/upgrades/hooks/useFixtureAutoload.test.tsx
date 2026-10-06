import { Spec } from '@generated/proto/common';
import { fakeHost } from '@sim/testing';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Ranking } from '../model/engine/rank';
import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { FIXTURE_SCHEMA_VERSION } from '../utils/fixture';

const FIXTURE = {
	schemaVersion: FIXTURE_SCHEMA_VERSION,
	forkSha: 'cb561067',
	spec: 'ret',
	phase: 2,
	gear: { items: [] },
	recordedAt: '2026-10-01T00:00:00Z',
	iterations: 3000,
	ranking: RANKING_FIXTURE,
};

const host = fakeHost({
	sim: { waitForInit: async () => {}, setPhase: () => {}, getPhase: () => 2, db: { lookupEquipmentSpec: () => ({}) } },
	player: { getSpec: () => Spec.SpecRetributionPaladin, setGear: () => {}, getGear: () => ({ asSpec: () => ({ items: [] }) }) },
});

type Options = { onLoaded: (ranking: Ranking) => void; currentRanking: () => Ranking | undefined };

/**
 * `FIXTURES_ENABLED` is read once at module load, so each define value needs a
 * fresh module graph, and the provider must come from the same graph as the hook.
 */
const importHook = async (enabled: boolean) => {
	vi.resetModules();
	vi.stubGlobal('__TBC_TAB_FIXTURES__', enabled);
	const { useFixtureAutoload } = await import('./useFixtureAutoload');
	const { SimHostProvider } = await import('@sim/context/SimHostContext');
	const wrapper = ({ children }: { children: ReactNode }) => <SimHostProvider host={host}>{children}</SimHostProvider>;
	return (options: Options) => renderHook((props: Options) => useFixtureAutoload(props), { wrapper, initialProps: options });
};

const installedLoader = () => {
	const loader = window.__upgradesFixture;
	if (!loader) throw new Error('window.__upgradesFixture is not installed');
	return loader;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('useFixtureAutoload on a dev build', () => {
	it('installs both page hooks and removes them on unmount', async () => {
		const { unmount } = (await importHook(true))({ onLoaded: () => {}, currentRanking: () => undefined });
		expect(window.__upgradesFixture).toBeTypeOf('function');
		expect(window.__upgradesRanking).toBeTypeOf('function');

		unmount();
		expect(window.__upgradesFixture).toBeUndefined();
		expect(window.__upgradesRanking).toBeUndefined();
	});

	it('loads a fixture into the page and hands its ranking to onLoaded', async () => {
		const onLoaded = vi.fn();
		(await importHook(true))({ onLoaded, currentRanking: () => undefined });

		await expect(installedLoader()(FIXTURE)).resolves.toEqual({ ok: true, rows: RANKING_FIXTURE.items.length });
		expect(onLoaded).toHaveBeenCalledWith(RANKING_FIXTURE);
	});

	it('refuses a fixture recorded for another spec', async () => {
		const onLoaded = vi.fn();
		(await importHook(true))({ onLoaded, currentRanking: () => undefined });

		await expect(installedLoader()({ ...FIXTURE, spec: 'feral' })).resolves.toMatchObject({ ok: false, reason: 'spec' });
		expect(onLoaded).not.toHaveBeenCalled();
	});

	it('keeps one install across re-renders and calls the latest callbacks', async () => {
		const first = vi.fn();
		const latest = vi.fn();
		const { rerender } = (await importHook(true))({ onLoaded: first, currentRanking: () => undefined });
		const installed = window.__upgradesFixture;

		rerender({ onLoaded: latest, currentRanking: () => RANKING_FIXTURE });
		expect(window.__upgradesFixture).toBe(installed);

		await installedLoader()(FIXTURE);
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledOnce();
		expect(window.__upgradesRanking?.()).toMatchObject({ ranking: RANKING_FIXTURE, spec: 'ret', phase: 2 });
	});
});

describe('useFixtureAutoload on a production build', () => {
	it('installs nothing', async () => {
		(await importHook(false))({ onLoaded: () => {}, currentRanking: () => RANKING_FIXTURE });
		expect(window.__upgradesFixture).toBeUndefined();
		expect(window.__upgradesRanking).toBeUndefined();
	});
});
