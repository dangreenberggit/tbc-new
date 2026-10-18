/**
 * The run's assumptions as one console line (ticket 318), ported from the old
 * tab's `logAssumptions` (cb561067 `upgrades_tab.tsx`). Every item on it was a
 * restatement of a control or detail no player can act on, so it left the
 * page; it is still what someone diagnosing a bad ranking reads. Plain English
 * on purpose: a console line is a diagnostic, not localised UI.
 */

import { bisTagPhaseFor, epWeightsDisclosureFor, type PagePoolHost, poolFor, poolSourceFor, unsourcedCountFor } from './data/data';
import type { Substitution } from './engine/disclosure';
import type { Ranking } from './engine/rank';
import type { SpecId } from './engine/types';
import type { RunSettings } from './run_state';

export type AssumptionsContext = {
	/** The ranked spec; absent, the lines that depend on the bundled data are left out. */
	specId?: SpecId;
	/** The settings the run used; absent for a loaded fixture, whose run settings are not recorded. */
	settings?: RunSettings;
	/** The page the run drew its pool from; absent, or before its database has loaded, the lines about the pool are left out. */
	host?: PagePoolHost;
};

export function assumptionsLine(ranking: Pick<Ranking, 'assumptions' | 'cutoff'>, { specId, settings, host }: AssumptionsContext = {}): string {
	const a = ranking.assumptions;
	const lines = [`seeds: ${a.seeds.join(', ')}`, `iterations: ${a.iterations}`, `max phase: ${a.maxPhase}`, `cutoff: ${ranking.cutoff.absDps} DPS`];
	if (settings) lines.push(`candidate pool: ${settings.prune ? `selected set items for phase ${a.maxPhase}` : 'every eligible item'}`);
	if (specId) {
		const maxPhase = a.maxPhase;
		const page = host?.sim.db ? host : undefined;
		const pool = page ? poolFor(page, maxPhase) : undefined;
		const poolSource = pool && poolSourceFor(pool);
		if (poolSource) lines.push(`pool source: ${poolSource.name} (${poolSource.entries} entries)`);
		const ep = epWeightsDisclosureFor(specId, maxPhase);
		if (ep) lines.push(`EP weights: written for ${ep.from}, ranking ${ep.requested}`);
		const tags = page && bisTagPhaseFor(page, page.individualConfig.presets.gear, maxPhase);
		if (tags && tags.tagsFromPhase < tags.requestedPhase) lines.push(`BiS tags: from P${tags.tagsFromPhase} sets, ranking P${tags.requestedPhase}`);
		const unsourced = pool ? unsourcedCountFor(pool) : 0;
		if (unsourced > 0) lines.push(`source attribution: partial, ${unsourced} items with no recorded source`);
	}
	if (settings) {
		if (settings.candidateCap !== undefined) lines.push(`candidate cap: top ${settings.candidateCap} simmed in full, plus anything you already own`);
		const excluded = settings.excludedSources ?? [];
		lines.push(excluded.length === 0 ? 'sources: all' : `sources: excluded ${excluded.join(', ')}`);
		const sets = settings.guaranteedSetKeys ?? [];
		lines.push(sets.length === 0 ? 'sets: none' : `sets: ${sets.join(', ')}`);
	}
	return `[upgrades] assumptions — ${lines.join(' · ')}`;
}

/**
 * A substitution caused by a sim crash carries the whole Go stack trace, and
 * its first line already says what went wrong (ticket 311). The trace's breaks
 * arrive both as real newlines and as written-out backslash-n pairs, because
 * the sim's error object is stringified into the detail.
 */
export function substitutionFirstLine(detail: string): { line: string; truncated: boolean } {
	const line = detail.split(/\r?\n|\\n/, 1)[0] ?? detail;
	return { line, truncated: line !== detail };
}

/** The full text of every reason the page shortens; the page says it is in the console. */
export const substitutionConsoleLines = (substitutions: readonly Substitution[]): string[] =>
	substitutions.filter(s => substitutionFirstLine(s.detail).truncated).map(s => `[upgrades] ${s.field}: ${s.detail}`);
