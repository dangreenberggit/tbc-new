/**
 * Build RecordedGearSourceData from the slamaltman raw fixture, via the
 * ranked route.
 */

import type { RecordedGearSourceData } from '../seams/gear-source';
import type { CharacterRef } from '../types';
import { buildOfflineRecordings, type ReportEventsRawFixture } from './report-events-offline';

export type SlamaltmanRawFixture = ReportEventsRawFixture;

export const SLAMALTMAN_REF: CharacterRef = {
	region: 'US',
	realm: 'dreamscythe',
	name: 'slamaltman',
};

export function slamaltmanOfflineRecordings(raw: SlamaltmanRawFixture): RecordedGearSourceData {
	return buildOfflineRecordings(raw, SLAMALTMAN_REF, 'ret', 'ranked', 1, () => 'slamaltman not found in raw fixture', '2026-07-01T00:00:00.000Z');
}
