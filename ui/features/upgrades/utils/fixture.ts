/**
 * Recorded-fixture loading for the Upgrades tab (ticket 504). Developer and
 * gate use only.
 *
 * A fixture is a finished `Ranking` recorded from a real run, plus the phase
 * and gear the run used. Rendering one takes seconds and needs no backend and
 * no WASM run, which is what lets the layout gate and `pnpm tab-review` check
 * set-bonus rows that the gate's own live ret run never produces. The fixtures
 * and their recorder live in the main repo (`data/tab-fixtures/`,
 * `scripts/tab-fixtures/record.mjs`); the dev server's `tabFixtures` plugin
 * serves them (`tools/vite/tab_fixtures.mts`).
 *
 * Every caller sits behind `FIXTURES_ENABLED` (`dev_flags.ts`), so a
 * production build drops them as dead code.
 *
 * Not a fourth port: nothing here feeds `rankUpgrades`. It replaces the
 * result of a run, not any input to one.
 */

import type { Spec } from '@generated/proto/common';
import { EquipmentSpec } from '@generated/proto/common';
import type { JsonObject } from '@protobuf-ts/runtime';
import type { IndividualSimHost } from '@sim/sim_host';

import type { Ranking } from '../model/engine/rank';
import type { SpecId } from '../model/engine/types';
import { specIdFor } from '../model/run';

export const FIXTURE_SCHEMA_VERSION = 1;

export type TabFixture = {
	schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
	forkSha: string;
	spec: SpecId;
	phase: number;
	preset?: string;
	gearUrl?: string;
	/** protojson `EquipmentSpec`, as `EquipmentSpec.toJson` writes it. */
	gear: JsonObject;
	recordedAt: string;
	iterations: number;
	ranking: Ranking;
};

export type FixtureLoadResult = { ok: true; rows: number } | { ok: false; reason: string; detail?: string };

/** The reason a file is refused before the page sees it: its text is not JSON. */
export const FIXTURE_NOT_JSON = 'not_json';

/** What `window.__upgradesRanking` hands the recorder: the ranking plus what it was measured against. */
export type FixtureRecording = { ranking: Ranking; spec: SpecId | undefined; phase: number; gear: unknown };

declare global {
	interface Window {
		__upgradesFixture?: (payload: unknown) => Promise<FixtureLoadResult>;
		__upgradesRanking?: () => FixtureRecording | null;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The first thing a payload lacks, or undefined when it is a fixture. Checks the fields the tab reads. */
function fixtureProblem(payload: unknown): string | undefined {
	if (!isRecord(payload)) return 'not an object';
	if (payload.schemaVersion !== FIXTURE_SCHEMA_VERSION) return `schemaVersion ${String(payload.schemaVersion)} is not ${FIXTURE_SCHEMA_VERSION}`;
	for (const key of ['forkSha', 'spec', 'recordedAt'] as const) {
		if (typeof payload[key] !== 'string' || payload[key] === '') return `${key} missing`;
	}
	if (!Number.isInteger(payload.phase)) return 'phase missing';
	if (typeof payload.iterations !== 'number') return 'iterations missing';
	if (!isRecord(payload.gear)) return 'gear missing';
	if (!isRecord(payload.ranking) || !Array.isArray(payload.ranking.items)) return 'ranking missing';
	return undefined;
}

const isTabFixture = (payload: unknown): payload is TabFixture => fixtureProblem(payload) === undefined;

export function validateFixture(payload: unknown): { ok: true; fixture: TabFixture } | { ok: false; reason: string } {
	if (isTabFixture(payload)) return { ok: true, fixture: payload };
	return { ok: false, reason: fixtureProblem(payload) ?? 'not a fixture' };
}

/**
 * Loads a fixture into the page: phase, then gear, then the result.
 *
 * The order matters. Phase and gear changes are what a later staleness mark
 * (P3) listens to, so the result goes in last, after one macrotask has let
 * those listeners run; otherwise the fixture would render already stale.
 */
export async function loadFixture(host: IndividualSimHost<Spec>, payload: unknown, show: (ranking: Ranking) => void): Promise<FixtureLoadResult> {
	const checked = validateFixture(payload);
	if (!checked.ok) {
		console.error(`[upgrades] fixture rejected: ${checked.reason}`);
		return checked;
	}
	const { fixture } = checked;
	const pageSpec = specIdFor(host.player.getSpec());
	if (fixture.spec !== pageSpec) {
		return { ok: false, reason: 'spec', detail: `fixture is ${fixture.spec}, page is ${pageSpec ?? 'unranked'}` };
	}
	await host.sim.waitForInit();
	host.sim.setPhase(fixture.phase);
	host.player.setGear(host.sim.db.lookupEquipmentSpec(EquipmentSpec.fromJson(fixture.gear, { ignoreUnknownFields: true })));
	await new Promise(resolve => setTimeout(resolve, 0));
	show(fixture.ranking);
	return { ok: true, rows: fixture.ranking.items.length };
}

/** The dev server's route for one fixture's JSON (`tools/vite/tab_fixtures.mts`). */
export const fixtureUrl = (name: string): string => `/tbc/tab-fixtures/${encodeURIComponent(name)}.json`;

export async function fetchFixture(name: string): Promise<TabFixture> {
	const response = await fetch(fixtureUrl(name));
	if (!response.ok) throw new Error(`no fixture named ${name} (HTTP ${response.status})`);
	const checked = validateFixture(await response.json());
	if (!checked.ok) throw new Error(`fixture ${name} rejected: ${checked.reason}`);
	return checked.fixture;
}

export const recordingOf = (host: IndividualSimHost<Spec>, ranking: Ranking | undefined): FixtureRecording | null =>
	ranking
		? {
				ranking,
				spec: specIdFor(host.player.getSpec()),
				phase: host.sim.getPhase(),
				// The recorder saves this beside the ranking so a fixture keeps the
				// gear its figures were measured against.
				gear: EquipmentSpec.toJson(host.player.getGear().asSpec()),
			}
		: null;
