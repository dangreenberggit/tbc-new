import i18n from '@i18n/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import englishCharacter from '../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../assets/locales/en/translation.json';
import { RankError } from '../model/engine/rank';
import type { RunProgressView } from '../model/run_progress';
import { describeRunError, formatDelta, formatDps, formatSeconds, progressBarOf, progressLabel, progressStageOf, slotLabel, sourceLabel } from './format';

beforeAll(() => {
	i18n.addResourceBundle('en', 'translation', englishTranslations, true, true);
	i18n.addResourceBundle('en', 'character', englishCharacter, true, true);
});
afterAll(() => {
	i18n.removeResourceBundle('en', 'translation');
	i18n.removeResourceBundle('en', 'character');
});

const view = (overrides: Partial<RunProgressView>): RunProgressView => ({
	phase: 'preparing',
	stage: 'resolving',
	boundary: null,
	concurrency: 1,
	qualifyingRows: 0,
	...overrides,
});

describe('formatDelta', () => {
	it('signs a gain and keeps one decimal', () => {
		expect(formatDelta(45.745)).toBe('+45.7');
	});

	it('takes the sign of a loss from the number, never a doubled sign', () => {
		expect(formatDelta(-41)).toBe('-41.0');
	});

	it('shows no sign on zero', () => {
		expect(formatDelta(0)).toBe('0.0');
	});
});

describe('formatDps and formatSeconds', () => {
	it('round to one decimal', () => {
		expect(formatDps(2084.1635)).toBe('2,084.2');
		expect(formatSeconds(2549)).toBe('2.5');
	});
});

describe('slotLabel', () => {
	it('names a pool slot by its sim slot, with the page’s own slot names', () => {
		expect(slotLabel({ slot: 'head' })).toBe('Head');
		expect(slotLabel({ slot: 'weapon' })).toBe('Main Hand');
		expect(slotLabel({ slot: 'finger', slotChoice: 'finger2' })).toBe('Ring 2');
	});
});

describe('sourceLabel', () => {
	it('names a zone for a drop and the engine’s label otherwise', () => {
		expect(sourceLabel({ kind: 'raid', zone: 'Black Temple', boss: 'Illidan' })).toBe('Black Temple');
		expect(sourceLabel({ kind: 'badge', cost: 75 })).toBe('Badge vendor');
	});
});

describe('describeRunError', () => {
	it('explains a spec the engine has no data for', () => {
		expect(describeRunError(new RankError('not-implemented', 'no data'))).toBe('This spec has no ranking data yet.');
	});

	it('quotes any other failure', () => {
		expect(describeRunError(new Error('worker died'))).toBe('Ranking failed: worker died');
		expect(describeRunError('boom')).toBe('Ranking failed: boom');
	});
});

describe('progress', () => {
	it('reads the stage while preparing and the phase after', () => {
		expect(progressStageOf(null)).toBe('resolving');
		expect(progressStageOf(view({ stage: 'building-pool' }))).toBe('building-pool');
		expect(progressStageOf(view({ phase: 'replication', stage: 'simming' }))).toBe('replication');
	});

	it('labels each stage', () => {
		expect(progressLabel('building-pool')).toBe('Building the candidate pool…');
		expect(progressLabel('candidates')).toBe('Simming candidates');
	});

	it('fills the bar from the sims done', () => {
		expect(progressBarOf(view({ phase: 'candidates', stage: 'simming', done: 3, total: 12 }))).toEqual({ current: 3, total: 12 });
	});
});
