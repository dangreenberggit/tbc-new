import { Spec } from '@generated/proto/common';
import { fakeHost as fakeSimHost } from '@sim/testing';
import { describe, expect, it, vi } from 'vitest';

import { RANKING_FIXTURE } from '../testing/ranking_fixture';
import { fetchFixture, FIXTURE_SCHEMA_VERSION, loadFixture, type TabFixture, validateFixture } from './fixture';

const FIXTURE: TabFixture = {
	schemaVersion: FIXTURE_SCHEMA_VERSION,
	forkSha: 'cb561067',
	spec: 'ret',
	phase: 2,
	gear: { items: [] },
	recordedAt: '2026-10-01T00:00:00Z',
	iterations: 3000,
	ranking: RANKING_FIXTURE,
};

const fakeHost = (spec = Spec.SpecRetributionPaladin) => {
	const calls: string[] = [];
	const gear = { gear: true };
	const host = fakeSimHost({
		sim: {
			waitForInit: async () => void calls.push('init'),
			setPhase: (phase: number) => calls.push(`phase ${phase}`),
			db: { lookupEquipmentSpec: () => gear },
		},
		player: { getSpec: () => spec, setGear: (next: unknown) => calls.push(next === gear ? 'gear' : 'wrong gear') },
	});
	return { host, calls };
};

describe('validateFixture', () => {
	it('accepts a recorded fixture', () => {
		expect(validateFixture(FIXTURE)).toEqual({ ok: true, fixture: FIXTURE });
	});

	it('names the first missing field', () => {
		expect(validateFixture({ ...FIXTURE, schemaVersion: 2 })).toMatchObject({ ok: false, reason: 'schemaVersion 2 is not 1' });
		expect(validateFixture({ ...FIXTURE, spec: '' })).toEqual({ ok: false, reason: 'spec missing' });
		expect(validateFixture({ ...FIXTURE, ranking: {} })).toEqual({ ok: false, reason: 'ranking missing' });
		expect(validateFixture([])).toEqual({ ok: false, reason: 'not an object' });
	});
});

describe('loadFixture', () => {
	it('sets the phase, then the gear, then shows the ranking, and counts its rows', async () => {
		const { host, calls } = fakeHost();
		const show = vi.fn(() => calls.push('show'));

		await expect(loadFixture(host, FIXTURE, show)).resolves.toEqual({ ok: true, rows: RANKING_FIXTURE.items.length });
		expect(calls).toEqual(['init', 'phase 2', 'gear', 'show']);
		expect(show).toHaveBeenCalledWith(RANKING_FIXTURE);
	});

	it('refuses a fixture recorded for another spec and changes nothing', async () => {
		const { host, calls } = fakeHost(Spec.SpecFeralCatDruid);
		const show = vi.fn();

		await expect(loadFixture(host, FIXTURE, show)).resolves.toEqual({ ok: false, reason: 'spec', detail: 'fixture is ret, page is feral' });
		expect(calls).toEqual([]);
		expect(show).not.toHaveBeenCalled();
	});
});

describe('fetchFixture', () => {
	it('reads the fixture the dev server serves under its name', async () => {
		const fetchStub = vi.fn(async () => new Response(JSON.stringify(FIXTURE), { headers: { 'content-type': 'application/json' } }));
		vi.stubGlobal('fetch', fetchStub);

		await expect(fetchFixture('ret-p3-p2')).resolves.toEqual(FIXTURE);
		expect(fetchStub).toHaveBeenCalledWith('/tbc/tab-fixtures/ret-p3-p2.json');
	});

	it('fails on a fixture the dev server does not have', async () => {
		vi.stubGlobal('fetch', async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }));

		await expect(fetchFixture('nope')).rejects.toThrow('no fixture named nope');
	});
});
