/**
 * Build RecordedGearSourceData from the Stage 0 slamaltman raw fixture, via
 * the ranked route.
 *
 * PORTED from packages/core/src/fixtures/slamaltman-offline.ts, unchanged
 * except for import paths.
 */

import {
  buildOfflineRecordings,
  type ReportEventsRawFixture,
} from "./report-events-offline.js";
import type { RecordedGearSourceData } from "../seams/gear-source.js";
import type { CharacterRef } from "../types.js";

export type SlamaltmanRawFixture = ReportEventsRawFixture;

export const SLAMALTMAN_REF: CharacterRef = {
  region: "US",
  realm: "dreamscythe",
  name: "slamaltman",
};

export function slamaltmanOfflineRecordings(
  raw: SlamaltmanRawFixture
): RecordedGearSourceData {
  return buildOfflineRecordings(
    raw,
    SLAMALTMAN_REF,
    "ret",
    "ranked",
    1,
    () => "slamaltman not found in raw fixture",
    "2026-07-01T00:00:00.000Z"
  );
}
