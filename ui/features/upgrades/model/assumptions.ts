/**
 * The run's assumptions as one console line, for diagnosing a bad ranking. No
 * player can act on these, so none is on the page. Plain English on purpose: a
 * console line is a diagnostic, not localised UI.
 */

import { bisTagPhaseFor, epWeightsDisclosureFor, type EpWeightsPreset, type PagePoolHost, poolFor, poolSourceFor, unsourcedCountFor } from './data/data';
import type { Substitution } from './engine/disclosure';
import type { Ranking } from './engine/rank';
import type { RunSettings } from './run_state';

export type AssumptionsContext = {
	/** Absent for a replay or a loaded fixture, which leaves out the EP-weights lines. */
	epWeightsPreset?: EpWeightsPreset;
	/** Absent for a loaded fixture, which does not record its run settings. */
	settings?: RunSettings;
	/** Without it, or before the page's database loads, the pool lines are left out. */
	host?: PagePoolHost;
};

export function assumptionsLine(ranking: Pick<Ranking, 'assumptions' | 'cutoff'>, { epWeightsPreset, settings, host }: AssumptionsContext = {}): string {
	const a = ranking.assumptions;
	const lines = [`seeds: ${a.seeds.join(', ')}`, `iterations: ${a.iterations}`, `max phase: ${a.maxPhase}`, `cutoff: ${ranking.cutoff.absDps} DPS`];
	if (settings) lines.push(`candidate pool: ${settings.prune ? `selected set items for phase ${a.maxPhase}` : 'every eligible item'}`);
	const maxPhase = a.maxPhase;
	const page = host?.sim.db ? host : undefined;
	const pool = page ? poolFor(page, page.individualConfig.presets.gear, maxPhase) : undefined;
	const poolSource = pool && poolSourceFor(pool);
	if (poolSource) lines.push(`pool source: ${poolSource.name} (${poolSource.entries} entries)`);
	if (epWeightsPreset) {
		lines.push(`EP weights set: ${epWeightsPreset}`);
		const ep = epWeightsDisclosureFor(epWeightsPreset, maxPhase);
		if (ep) lines.push(`EP weights: written for ${ep.from}, ranking ${ep.requested}`);
	}
	const tags = page && bisTagPhaseFor(page, page.individualConfig.presets.gear, maxPhase);
	if (tags && tags.tagsFromPhase < tags.requestedPhase) lines.push(`BiS tags: from P${tags.tagsFromPhase} sets, ranking P${tags.requestedPhase}`);
	const unsourced = pool ? unsourcedCountFor(pool) : 0;
	if (unsourced > 0) lines.push(`source attribution: partial, ${unsourced} items with no recorded source`);
	if (settings) {
		if (settings.candidateCap !== undefined) lines.push(`candidate cap: top ${settings.candidateCap} simmed in full, plus anything you already own`);
		const excluded = settings.excludedSources ?? [];
		lines.push(excluded.length === 0 ? 'sources: all' : `sources: excluded ${excluded.join(', ')}`);
		const sets = settings.selectedGearSetKeys ?? [];
		lines.push(sets.length === 0 ? 'sets: none' : `sets: ${sets.join(', ')}`);
	}
	return `[upgrades] assumptions — ${lines.join(' · ')}`;
}

/**
 * A sim crash's substitution carries the whole Go stack trace, whose first line
 * says what went wrong. Its line breaks arrive as real newlines and as written-out
 * backslash-n pairs, because the sim's error object is stringified into the detail.
 */
export function substitutionFirstLine(detail: string): { line: string; truncated: boolean } {
	const [line = detail, ...rest] = detail.split(/\r?\n|\\n/);
	// An empty error after the line leaves nothing for the console to add.
	return { line, truncated: rest.join('').trim() !== '' };
}

/** The full text of every reason the page shortens, and every failed call's error, which the page does not show. */
export const substitutionConsoleLines = (substitutions: readonly Substitution[]): string[] =>
	substitutions
		.filter(s => substitutionFirstLine(s.detail).truncated || s.error?.trim())
		.map(s => `[upgrades] ${s.field}: ${s.detail}${s.error ? `\n${s.error}` : ''}`);
