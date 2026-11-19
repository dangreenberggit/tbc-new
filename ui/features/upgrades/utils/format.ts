import { ItemSlot } from '@generated/proto/common';
import { DungeonDifficulty } from '@generated/proto/ui';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { difficultyNames } from '@sim/proto/names';
import { formatToNumber } from '@sim/utils/format';
import type { ProgressTrackerProgress } from '@ui-kit/ProgressTrackerDialog';

import { noteFirstLine } from '../model/assumptions';
import type { RunNote } from '../model/engine/disclosure';
import type { ItemSource } from '../model/engine/pool';
import { type RankedItem, RankError } from '../model/engine/rank';
import type { SimOrderName } from '../model/engine/slots';
import { ZONELESS_SOURCE_LABELS } from '../model/engine/view';
import type { SortLabels } from '../model/results_columns';
import { effectiveSlot } from '../model/results_view';
import type { RunActivity, RunProgressView } from '../model/run_progress';
import { type SourcedEntry, sourcesOf, zonelessSourceKey } from '../model/settings_pool';
import { shownTenths } from '../model/shown_figure';
import { FIXTURE_NOT_JSON, type FixtureLoadResult } from './fixture';

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

export const formatDps = (dps: number): string => formatToNumber(dps, ONE_DECIMAL);

export const formatSeconds = (ms: number): string => formatToNumber(ms / 1000, { ...ONE_DECIMAL, useGrouping: false });

/** The sign comes from the number, so a loss reads "-41.0". A figure below `cutoffDps`, the ranking's cutoff, never rounds up to it (`shownTenths`). */
export const formatDelta = (deltaDps: number, cutoffDps?: number): string =>
	i18n.t('upgrades_tab.results.delta_dps_value', {
		ns: 'upgrades',
		delta: `${deltaDps > 0 ? '+' : ''}${formatDps(shownTenths(deltaDps, cutoffDps) / 10)}`,
	});

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

export const simSlotLabel = (slot: SimOrderName): string => translateSlotName(ITEM_SLOT_BY_SIM_SLOT[slot]);

export const slotLabel = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): string => simSlotLabel(effectiveSlot(row));

/**
 * The English `ZONELESS_SOURCE_LABELS` stay as the pool's source keys (`settings_pool.ts`), so only the shown
 * text is translated; an unknown kind keeps its raw name.
 */
const kindLabel = (kind: string): string => (kind in ZONELESS_SOURCE_LABELS ? i18n.t(`upgrades_tab.sources.${kind}`, { ns: 'upgrades' }) : kind);

const KIND_BY_SOURCE_KEY = new Map(Object.entries(ZONELESS_SOURCE_LABELS).map(([kind, key]) => [key, kind]));

/** A Sources dialog key's shown name: a zone keeps its own name, any other key shows its source kind's name. */
export const sourceKeyLabel = (key: string): string => {
	const kind = KIND_BY_SOURCE_KEY.get(key);
	return kind === undefined ? key : kindLabel(kind);
};

/** A source as its cell shows it: the zone of a drop, else its kind. */
export const sourceLabel = (source: ItemSource): string => ('zone' in source ? source.zone : kindLabel(source.kind));

const DETAIL_SEPARATOR = ' · ';

const joinDetail = (...parts: (string | undefined)[]): string => parts.filter(part => part !== undefined).join(DETAIL_SEPARATOR);

/** Every raid drop in `db.json` is Normal and a token's zone is always a raid, so a token row shows the Normal mark as a drop row does. */
const TOKEN_DIFFICULTY = difficultyNames.get(DungeonDifficulty.DifficultyNormal);

/** A Magisters' Terrace heroic drop is grouped under the zone's own row, so its text shows the Heroic mark as `ItemSource` does. */
const HEROIC_DIFFICULTY = difficultyNames.get(DungeonDifficulty.DifficultyHeroic);

/**
 * A source as the Source cell's plain text shows it: what the row adds to its zone or source kind — a drop's boss, a
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

const NO_BREAK_SPACE = '\u00a0';

const DIFFICULTY_MARKS = [...new Set(difficultyNames.values())].map(name => ` (${name})`);

/**
 * `text` as the Source cell draws it: a no-break space before each difficulty mark, so a narrow cell breaks
 * "Tempest Keep (N)" before "Keep" and never leaves "(N)" alone on a line. Only the drawn text changes:
 * `sourceDetail` keeps the plain space, because the column sorts on it and tests compare it with recorded text.
 */
export const keepMarkWithZone = (text: string): string => DIFFICULTY_MARKS.reduce((out, mark) => out.replaceAll(mark, NO_BREAK_SPACE + mark.slice(1)), text);

export const zoneWithMark = (zone: string, difficulty: DungeonDifficulty): string =>
	keepMarkWithZone(`${zone} (${difficultyNames.get(difficulty) ?? 'Unknown'})`);

/**
 * The key "Filter by source" would hide one source by: a drop's zone, else its kind's key (`zonelessSourceKey`).
 * The filter judges a row that has a zone by its zones alone (`sourceMatches`), so the cell checks each
 * source on its own and never names one the user hid.
 */
const ownSourceKey = (source: ItemSource): string => ('zone' in source ? source.zone : zonelessSourceKey(source.kind));

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
 * source "Filter by source" hides. A row from two zones names one of them, as `ItemSource` names its first drop.
 */
export const rowSourceDetail = (row: SourcedEntry, hidden: readonly string[] = []): string => sourceDetail(shownSourceOf(row, hidden));

/**
 * The slot and source columns sort on the text their cells show (`rowSourceDetail` under the hidden sources), so a
 * reputation row sorts on its faction, not under "Reputation". The export sorts with the same labels.
 */
export const sortLabelsFor = (hiddenSources: readonly string[]): SortLabels<Pick<RankedItem, 'slot' | 'slotChoice'> & SourcedEntry> => ({
	slot: slotLabel,
	source: row => rowSourceDetail(row, hiddenSources),
});

export const fixtureOutcomeText = (outcome: FixtureLoadResult): string => {
	if (outcome.ok) return i18n.t('upgrades_tab.settings.fixture_loaded', { ns: 'upgrades', rows: outcome.rows });
	if (outcome.reason === FIXTURE_NOT_JSON) return i18n.t('upgrades_tab.settings.fixture_not_json', { ns: 'upgrades' });
	return i18n.t('upgrades_tab.settings.fixture_rejected', { ns: 'upgrades', reason: outcome.detail ?? outcome.reason });
};

/** A label in the list of left-out items. An item line adds the slot it was tried in, because its text says only "this slot". */
export const noteLabel = (note: RunNote): string =>
	note.slot ? i18n.t('upgrades_tab.assumptions.note_in_slot', { ns: 'upgrades', field: note.field, slot: simSlotLabel(note.slot) }) : note.field;

/** A reason in the run's notes, as shown: its first line. The run logs the whole text to the console. */
export const noteText = (detail: string): string => noteFirstLine(detail).line;

/** The status line names no error: `run_session.ts` shows the error's own message in a toast. */
export const describeRunError = (error: unknown): string => {
	if (error instanceof RankError && error.kind === 'not-implemented') return i18n.t('upgrades_tab.status.unsupported_spec', { ns: 'upgrades' });
	return i18n.t('upgrades_tab.status.error', { ns: 'upgrades' });
};

/** What the progress dialog names: the engine's stage until sims start, the run activity after. */
export type ProgressStage = Exclude<RunProgressView['stage'], 'simming'> | Exclude<RunActivity, 'preparing'>;

export const progressStageOf = (view: RunProgressView | null): ProgressStage => {
	if (!view) return 'resolving';
	if (view.activity !== 'preparing') return view.activity;
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
