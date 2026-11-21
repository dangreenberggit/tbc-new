/**
 * What a run settles before its first sim: iterations and seeds, the fight, and the race and
 * talents read from the page's request.
 */

import type { ResolvedFight } from './rank-types';
import { DEFAULT_SEED_COUNT, replicateSeeds } from './se';
import type { FightSummary } from './seams/gear-source';
import type { RaidSimRequest } from './seams/sim-runner';
import type { FightRef, Race, SpecId } from './types';

/**
 * Used when a caller passes no count; the tab always passes its own
 * (`TAB_DEFAULT_ITERATIONS`). Flat, not adaptive. The count is part of every
 * ranking cache key.
 */
export const DEFAULT_ITERATIONS = 5000;

/**
 * First of the default seeds, which are distinct because
 * `usesPairedReplication` (`se.ts`) needs more than one, and spaced by the
 * iteration count: the sim seeds iteration `i` from `RandomSeed + i`
 * (`reseedRands` in `sim/core/sim.go`), so seeds closer than the iteration
 * count share most of their random streams and their SE comes out far too
 * small.
 */
export const DEFAULT_SEED_BASE = 11;

/**
 * Derived from the run's resolved iteration count, not `DEFAULT_ITERATIONS`:
 * a caller passing `iterations: 10000` would otherwise get seeds 5,000 apart,
 * which overlap and fail `assertUsableSeeds`.
 */
export function defaultSeedsFor(iterations: number): number[] {
	return replicateSeeds(DEFAULT_SEED_BASE, DEFAULT_SEED_COUNT, iterations);
}

/**
 * Per-spec preset id, disclosed in `Assumptions.presetId`. A stable label, not
 * a file path: the skeleton is the page's own current settings.
 */
const PRESET_ID_BY_SPEC: Record<SpecId, string> = {
	ret: 'ret/current-page-settings',
	feral: 'feral/current-page-settings',
	balance: 'balance/current-page-settings',
	hunter: 'hunter/current-page-settings',
	mage: 'mage/current-page-settings',
	shadow: 'shadow/current-page-settings',
	rogue: 'rogue/current-page-settings',
	ele: 'ele/current-page-settings',
	enh: 'enh/current-page-settings',
	warlock: 'warlock/current-page-settings',
	warrior: 'warrior/current-page-settings',
};

export function presetIdFor(spec: SpecId): string {
	return PRESET_ID_BY_SPEC[spec];
}

export function resolveFight(fights: readonly FightSummary[], requested?: FightRef): ResolvedFight | undefined {
	if (requested) {
		const match = fights.find(f => f.reportCode === requested.reportCode && f.fightId === requested.fightId);
		return match
			? summaryToResolved(match)
			: {
					...requested,
					route: 'report-events',
				};
	}
	const ranked = fights.find(f => f.route === 'ranked');
	const chosen = ranked ?? fights[0];
	return chosen ? summaryToResolved(chosen) : undefined;
}

function summaryToResolved(f: FightSummary): ResolvedFight {
	return {
		reportCode: f.reportCode,
		fightId: f.fightId,
		...(f.encounterName ? { encounterName: f.encounterName } : {}),
		...(f.killedAt ? { killedAt: f.killedAt } : {}),
		route: f.route,
		confidence: f.confidence,
		...(f.salvationUptime === undefined ? {} : { salvationUptime: f.salvationUptime }),
	};
}

export function raceFromSkeleton(skeleton: RaidSimRequest): Race {
	const raw = (
		skeleton as {
			raid?: { parties?: Array<{ players?: Array<{ race?: string }> }> };
		}
	).raid?.parties?.[0]?.players?.[0]?.race;
	if (raw && isRace(raw)) return raw;
	return 'RaceHuman';
}

export function talentsStringFromRequest(request: RaidSimRequest): string | undefined {
	const raw = (
		request as {
			raid?: {
				parties?: Array<{ players?: Array<{ talentsString?: string }> }>;
			};
		}
	).raid?.parties?.[0]?.players?.[0]?.talentsString;
	return typeof raw === 'string' ? raw : undefined;
}

function isRace(value: string): value is Race {
	return (
		value === 'RaceHuman' ||
		value === 'RaceDwarf' ||
		value === 'RaceNightElf' ||
		value === 'RaceGnome' ||
		value === 'RaceDraenei' ||
		value === 'RaceOrc' ||
		value === 'RaceUndead' ||
		value === 'RaceTauren' ||
		value === 'RaceTroll' ||
		value === 'RaceBloodElf'
	);
}
