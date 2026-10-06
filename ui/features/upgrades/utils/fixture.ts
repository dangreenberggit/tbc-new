/**
 * Recorded-fixture loading for the Upgrades tab (ticket 504). Developer and
 * gate use only.
 *
 * A fixture is a finished `Ranking` recorded from a real run, plus the phase
 * and gear the run used. Rendering one takes seconds and needs no backend and
 * no WASM run, which is what lets the layout gate and `pnpm tab-review` check
 * set-bonus rows that the gate's own live ret run never produces. The fixtures
 * and their recorder live in the main repo (`data/tab-fixtures/`,
 * `scripts/tab-fixtures/record.mjs`).
 *
 * This module is imported only behind the `__TBC_TAB_FIXTURES__` build-time
 * define (vite.config.mts), so a production build without `TBC_TAB_FIXTURES=1`
 * contains none of it. The harnesses reach it through `window.__upgradesFixture`
 * over CDP. (The old `?upgrades-dev` file input was not carried onto the React
 * tab; ticket 558.)
 *
 * Not a fourth port: nothing here feeds `rankUpgrades`. It replaces the
 * result of a run, not any input to one.
 */

import type { Spec } from '@generated/proto/common';
import { EquipmentSpec } from '@generated/proto/common';
import type { IndividualSimHost } from '@sim/sim_host';

import type { Ranking } from '../model/engine/rank';
import type { SpecId } from '../model/engine/types';

export const FIXTURE_SCHEMA_VERSION = 1;

export type TabFixture = {
	schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
	forkSha: string;
	spec: SpecId;
	phase: number;
	preset?: string;
	gearUrl?: string;
	/** protojson `EquipmentSpec`, as `EquipmentSpec.toJson` writes it. */
	gear: Record<string, unknown>;
	recordedAt: string;
	iterations: number;
	ranking: Ranking;
};

export type FixtureLoadResult = { ok: true; rows: number } | { ok: false; reason: string; detail?: string };

/** What the tab exposes to this module, so its run state can stay private. */
export interface FixtureHost {
	readonly simUI: IndividualSimHost<Spec>;
	/** The page spec's engine id, or undefined for a spec the tab does not rank. */
	specId(): SpecId | undefined;
	/** The ranking on screen, or undefined when no finished run is shown. */
	currentRanking(): Ranking | undefined;
	/** Shows `ranking` as a finished, current run and returns the rendered row count. */
	showRanking(ranking: Ranking): number;
}

declare global {
	interface Window {
		__upgradesFixture?: (payload: unknown) => Promise<FixtureLoadResult>;
		__upgradesRanking?: () => { ranking: Ranking; spec: SpecId | undefined; phase: number; gear: unknown } | null;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateFixture(payload: unknown): { ok: true; fixture: TabFixture } | { ok: false; reason: string } {
	if (!isRecord(payload)) return { ok: false, reason: 'not an object' };
	if (payload.schemaVersion !== FIXTURE_SCHEMA_VERSION)
		return { ok: false, reason: `schemaVersion ${String(payload.schemaVersion)} is not ${FIXTURE_SCHEMA_VERSION}` };
	for (const key of ['forkSha', 'spec', 'recordedAt'] as const) {
		if (typeof payload[key] !== 'string' || payload[key] === '') return { ok: false, reason: `${key} missing` };
	}
	if (!Number.isInteger(payload.phase)) return { ok: false, reason: 'phase missing' };
	if (typeof payload.iterations !== 'number') return { ok: false, reason: 'iterations missing' };
	if (!isRecord(payload.gear)) return { ok: false, reason: 'gear missing' };
	if (!isRecord(payload.ranking) || !Array.isArray(payload.ranking.items)) return { ok: false, reason: 'ranking missing' };
	return { ok: true, fixture: payload as unknown as TabFixture };
}

/**
 * Loads a fixture into the page: phase, then gear, then the result.
 *
 * The order matters. Phase and gear changes mark a shown result stale through
 * the tab's listeners, so the result goes in last, after one macrotask has
 * let those listeners run; otherwise the fixture would render already marked
 * stale.
 */
export async function loadFixture(host: FixtureHost, payload: unknown): Promise<FixtureLoadResult> {
	const checked = validateFixture(payload);
	if (!checked.ok) {
		console.error(`[upgrades] fixture rejected: ${checked.reason}`);
		return checked;
	}
	const fixture = checked.fixture;
	const pageSpec = host.specId();
	if (fixture.spec !== pageSpec) {
		return { ok: false, reason: 'spec', detail: `fixture is ${fixture.spec}, page is ${pageSpec ?? 'unranked'}` };
	}
	const sim = host.simUI.sim;
	await sim.waitForInit();
	sim.setPhase(fixture.phase);
	const gear = sim.db.lookupEquipmentSpec(EquipmentSpec.fromJson(fixture.gear as never, { ignoreUnknownFields: true }));
	host.simUI.player.setGear(gear);
	await new Promise(resolve => setTimeout(resolve, 0));
	return { ok: true, rows: host.showRanking(fixture.ranking) };
}

export function installFixtureHooks(host: FixtureHost): void {
	window.__upgradesFixture = payload => loadFixture(host, payload);
	window.__upgradesRanking = () => {
		const ranking = host.currentRanking();
		if (!ranking) return null;
		return {
			ranking,
			spec: host.specId(),
			phase: host.simUI.sim.getPhase(),
			// The recorder saves this beside the ranking so a fixture keeps the
			// gear its figures were measured against.
			gear: EquipmentSpec.toJson(host.simUI.player.getGear().asSpec()),
		};
	};
}
