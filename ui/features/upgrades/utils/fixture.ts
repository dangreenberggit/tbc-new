/**
 * Recorded fixtures, for development and layout checks only: a finished `Ranking`
 * from a real run plus the phase and gear it used, rendered with no WASM run. The
 * fixtures, their recorder and the dev-server plugin that serves them are not part
 * of this repo. Every caller sits behind `FIXTURES_ENABLED` (`dev_flags.ts`), so a
 * production build drops them. A fixture replaces a run's result, never its input.
 */

import type { Spec } from '@generated/proto/common';
import { EquipmentSpec } from '@generated/proto/common';
import type { JsonObject } from '@protobuf-ts/runtime';
import type { IndividualSimHost } from '@sim/sim_host';

import type { Ranking } from '../model/engine/rank';
import type { SpecId } from '../model/engine/types';
import { specIdFor } from '../model/run';
import { isRecord } from './is_record';

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
 * Loads a fixture into the page: phase, then gear, then the result. The out-of-date
 * check (`useRunStale`) listens to phase and gear changes, so the result goes in
 * last, after one macrotask has let those listeners run; otherwise it would show as
 * out of date.
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

/** The dev server's route for one fixture's JSON, served by the fixture plugin. */
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
				// Saved beside the ranking: the gear its figures were measured against.
				gear: EquipmentSpec.toJson(host.player.getGear().asSpec()),
			}
		: null;
