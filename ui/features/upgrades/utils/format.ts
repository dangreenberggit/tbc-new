import { ItemSlot } from '@generated/proto/common';
import { DungeonDifficulty } from '@generated/proto/ui';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { difficultyNames } from '@sim/proto/names';
import { formatToNumber } from '@sim/utils/format';
import type { ProgressTrackerProgress } from '@ui-kit/ProgressTrackerDialog';

import { substitutionFirstLine } from '../model/assumptions';
import type { ItemSource } from '../model/engine/pool';
import { simSlotsForPoolSlot } from '../model/engine/pool';
import { type RankedItem, RankError } from '../model/engine/rank';
import type { SimOrderName } from '../model/engine/slots';
import { SOURCE_LABELS } from '../model/engine/view';
import type { SortLabels } from '../model/results_columns';
import type { RunPhase, RunProgressView } from '../model/run_progress';
import { bucketKeyOf, type SourcedEntry, sourcesOf } from '../model/settings_pool';
import { FIXTURE_NOT_JSON, type FixtureLoadResult } from './fixture';

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

export const formatDps = (dps: number): string => formatToNumber(dps, ONE_DECIMAL);

export const formatSeconds = (ms: number): string => formatToNumber(ms / 1000, { ...ONE_DECIMAL, useGrouping: false });

/** The sign comes from the number: a hard-coded `+` once printed "+-41.0" for a loss. */
export const formatDelta = (deltaDps: number): string =>
	i18n.t('upgrades_tab.results.delta_dps_value', { ns: 'upgrades', delta: `${deltaDps > 0 ? '+' : ''}${formatDps(deltaDps)}` });

const ITEM_SLOT_BY_SIM_SLOT: Record<SimOrderName, ItemSlot> = {
	head: ItemSlot.ItemSlotHead,
	neck: ItemSlot.ItemSlotNeck,
	shoulder: ItemSlot.ItemSlotShoulder,
	back: ItemSlot.ItemSlotBack,
	chest: ItemSlot.ItemSlotChest,
	wrist: ItemSlot.ItemSlotWrist,
	hands: ItemSlot.ItemSlotHands,
	waist: ItemSlot.ItemSlotWaist,
	legs: ItemSlot.ItemSlotLegs,
	feet: ItemSlot.ItemSlotFeet,
	finger1: ItemSlot.ItemSlotFinger1,
	finger2: ItemSlot.ItemSlotFinger2,
	trinket1: ItemSlot.ItemSlotTrinket1,
	trinket2: ItemSlot.ItemSlotTrinket2,
	mainhand: ItemSlot.ItemSlotMainHand,
	offhand: ItemSlot.ItemSlotOffHand,
	ranged: ItemSlot.ItemSlotRanged,
};

/** A sim slot in the page's own words. */
export const simSlotLabel = (slot: SimOrderName): string => translateSlotName(ITEM_SLOT_BY_SIM_SLOT[slot]);

/** `slotChoice` is set on every weapon row and wherever a pool slot maps to two sim slots; otherwise the first mapping is the slot. */
export const slotLabel = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): string => simSlotLabel(row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]);

/**
 * A source kind in the page's words. The engine's English `SOURCE_LABELS` stay the pool's source keys
 * (`settings_pool.ts`); a kind the map does not know keeps its raw name, as the engine's label does.
 */
const kindLabel = (kind: string): string => (kind in SOURCE_LABELS ? i18n.t(`upgrades_tab.sources.${kind}`, { ns: 'upgrades' }) : kind);

const KIND_BY_SOURCE_KEY = new Map(Object.entries(SOURCE_LABELS).map(([kind, key]) => [key, kind]));

/** A Sources dialog key in the page's words: a zone is its own name, a source bucket key is its kind's. */
export const sourceKeyLabel = (key: string): string => {
	const kind = KIND_BY_SOURCE_KEY.get(key);
	return kind === undefined ? key : kindLabel(kind);
};

/** A source as its cell shows it: the zone of a drop, else its kind. */
export const sourceLabel = (source: ItemSource): string => ('zone' in source ? source.zone : kindLabel(source.kind));

const DETAIL_SEPARATOR = ' · ';

const joinDetail = (...parts: (string | undefined)[]): string => parts.filter(part => part !== undefined).join(DETAIL_SEPARATOR);

/**
 * Every drop upstream's `db.json` records in a phase raid is Normal, and the universe builder keeps a token's zone to
 * the phase raids, so a token row prints upstream's Normal mark as a drop row does. The builder guard is "Token zones
 * stay phase raids only" in the main repo's `scripts/assemble_universe.py`; ticket 619 records the db.json check.
 */
const TOKEN_DIFFICULTY = difficultyNames.get(DungeonDifficulty.DifficultyNormal);

/** A Magisters' Terrace heroic drop keys under the zone's row, so its text carries upstream's Heroic mark as upstream's block does. */
const HEROIC_DIFFICULTY = difficultyNames.get(DungeonDifficulty.DifficultyHeroic);

/**
 * A source as the Source cell's plain text shows it: what the row holds beyond its zone or bucket — a drop's boss, a
 * token's difficulty and boss, a reputation's faction and standing, a PvP item's currency.
 */
export const sourceDetail = (source: ItemSource): string => {
	switch (source.kind) {
		case 'token':
			return joinDetail(`${source.zone} (${TOKEN_DIFFICULTY})`, source.boss);
		case 'raid':
			return joinDetail(source.heroic ? `${source.zone} (${HEROIC_DIFFICULTY})` : source.zone, source.boss);
		case 'heroic':
			return joinDetail(kindLabel(source.kind), source.dungeon);
		case 'rep':
			return joinDetail(source.faction, source.standing);
		case 'pvp':
			return joinDetail(kindLabel(source.kind), i18n.t(`upgrades_tab.source_detail.${source.via}`, { ns: 'upgrades' }));
		default:
			return sourceLabel(source);
	}
};

/**
 * The key "Filter by source" would hide one source by: a drop's zone, else its
 * bucket. The filter keeps or drops a row by its zones alone when it has one
 * (`sourceMatches`), but the Source cell keys each source by its own bucket,
 * so a kept row's cell does not name a bucket the user hid.
 */
const ownSourceKey = (source: ItemSource): string => ('zone' in source ? source.zone : bucketKeyOf(source.kind));

/** Whether any source of the row, first or not, is one `hidden` hides. */
export const rowNamesHiddenSource = (row: SourcedEntry, hidden: readonly string[]): boolean =>
	hidden.length > 0 && sourcesOf(row).some(source => hidden.includes(ownSourceKey(source)));

/**
 * The source a row's cell names while sources are hidden: its first source not hidden. A row "Filter by source" keeps
 * always has one; the first-source default is for a caller that passes a row the filter would drop.
 */
const shownSourceOf = (row: SourcedEntry, hidden: readonly string[]): ItemSource =>
	sourcesOf(row).find(source => !hidden.includes(ownSourceKey(source))) ?? row.sources?.[0] ?? row.source;

/**
 * The Source cell's plain text for a row: the detail of its first shown source only, so a kept row never names a
 * source "Filter by source" hides. A row from two zones names one of them, as upstream's block names its first drop.
 */
export const rowSourceDetail = (row: SourcedEntry, hidden: readonly string[] = []): string => sourceDetail(shownSourceOf(row, hidden));

/**
 * The slot column sorts on its cell's text and the source column on the detail its cell's plain text shows under the
 * acting hidden sources (`rowSourceDetail`), so the sort matches the cell (review AD2): a reputation row sorts on its
 * faction, not under "Reputation". The export sorts with the same labels, so its order is the order on screen.
 */
export const sortLabelsFor = (hiddenSources: readonly string[]): SortLabels<Pick<RankedItem, 'slot' | 'slotChoice'> & SourcedEntry> => ({
	slot: slotLabel,
	source: row => rowSourceDetail(row, hiddenSources),
});

/** What loading a fixture file did, in the page's words. */
export const fixtureOutcomeText = (outcome: FixtureLoadResult): string => {
	if (outcome.ok) return i18n.t('upgrades_tab.settings.fixture_loaded', { ns: 'upgrades', rows: outcome.rows });
	if (outcome.reason === FIXTURE_NOT_JSON) return i18n.t('upgrades_tab.settings.fixture_not_json', { ns: 'upgrades' });
	return i18n.t('upgrades_tab.settings.fixture_rejected', { ns: 'upgrades', reason: outcome.detail ?? outcome.reason });
};

/** A dropped candidate's reason as the page shows it: the first line, and where the rest went when it was cut. */
export const substitutionText = (detail: string): string => {
	const { line, truncated } = substitutionFirstLine(detail);
	return truncated ? `${line}${i18n.t('upgrades_tab.assumptions.substitution_truncated_suffix', { ns: 'upgrades' })}` : line;
};

export const describeRunError = (error: unknown): string => {
	if (error instanceof RankError && error.kind === 'not-implemented') return i18n.t('upgrades_tab.status.unsupported_spec', { ns: 'upgrades' });
	return i18n.t('upgrades_tab.status.error', { ns: 'upgrades', message: error instanceof Error ? error.message : String(error) });
};

/** What the progress dialog names: the engine's stage until sims start, the run phase after. */
export type ProgressStage = Exclude<RunProgressView['stage'], 'simming'> | Exclude<RunPhase, 'preparing'>;

export const progressStageOf = (view: RunProgressView | null): ProgressStage => {
	if (!view) return 'resolving';
	if (view.phase !== 'preparing') return view.phase;
	return view.stage === 'simming' ? 'candidates' : view.stage;
};

export const progressLabel = (stage: ProgressStage): string => {
	switch (stage) {
		case 'resolving':
			return i18n.t('upgrades_tab.progress.resolving', { ns: 'upgrades' });
		case 'reading-gear':
			return i18n.t('upgrades_tab.progress.reading_gear', { ns: 'upgrades' });
		case 'composing':
			return i18n.t('upgrades_tab.progress.composing', { ns: 'upgrades' });
		case 'building-pool':
			return i18n.t('upgrades_tab.progress.building_pool', { ns: 'upgrades' });
		case 'candidates':
			return i18n.t('upgrades_tab.run_progress.phase_candidates', { ns: 'upgrades' });
		case 'set-bonuses':
			return i18n.t('upgrades_tab.run_progress.phase_set_bonuses', { ns: 'upgrades' });
		case 'replication':
			return i18n.t('upgrades_tab.run_progress.phase_replication', { ns: 'upgrades' });
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking', { ns: 'upgrades' });
	}
};

export const progressBarOf = (view: RunProgressView): ProgressTrackerProgress => ({ current: view.done, total: view.total });
