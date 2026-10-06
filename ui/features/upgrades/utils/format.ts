import { ItemSlot } from '@generated/proto/common';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { formatToNumber } from '@sim/utils/format';
import type { ProgressTrackerProgress } from '@ui-kit/ProgressTrackerDialog';

import type { ItemSource } from '../model/engine/pool';
import { simSlotsForPoolSlot } from '../model/engine/pool';
import { type RankedItem, RankError } from '../model/engine/rank';
import type { SimOrderName } from '../model/engine/slots';
import { SOURCE_LABELS } from '../model/engine/view';
import type { RunPhase, RunProgressView } from '../model/run_progress';

const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };

export const formatDps = (dps: number): string => formatToNumber(dps, ONE_DECIMAL);

export const formatSeconds = (ms: number): string => formatToNumber(ms / 1000, { ...ONE_DECIMAL, useGrouping: false });

/** The sign comes from the number: a hard-coded `+` once printed "+-41.0" for a loss. */
export const formatDelta = (deltaDps: number): string =>
	i18n.t('upgrades_tab.results.delta_dps_value', { delta: `${deltaDps > 0 ? '+' : ''}${formatDps(deltaDps)}` });

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

/** `slotChoice` is set only where a pool slot maps to two sim slots; otherwise the first mapping is the slot. */
export const slotLabel = (row: Pick<RankedItem, 'slot' | 'slotChoice'>): string =>
	translateSlotName(ITEM_SLOT_BY_SIM_SLOT[row.slotChoice ?? simSlotsForPoolSlot(row.slot)[0]]);

/** The engine's own source text, which the desktop gate's golden compares cell for cell. */
export const sourceLabel = (source: ItemSource): string => ('zone' in source ? source.zone : (SOURCE_LABELS[source.kind] ?? source.kind));

export const describeRunError = (error: unknown): string => {
	if (error instanceof RankError && error.kind === 'not-implemented') return i18n.t('upgrades_tab.status.unsupported_spec');
	return i18n.t('upgrades_tab.status.error', { message: error instanceof Error ? error.message : String(error) });
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
			return i18n.t('upgrades_tab.progress.resolving');
		case 'reading-gear':
			return i18n.t('upgrades_tab.progress.reading_gear');
		case 'composing':
			return i18n.t('upgrades_tab.progress.composing');
		case 'building-pool':
			return i18n.t('upgrades_tab.progress.building_pool');
		case 'candidates':
			return i18n.t('upgrades_tab.run_progress.phase_candidates');
		case 'set-bonuses':
			return i18n.t('upgrades_tab.run_progress.phase_set_bonuses');
		case 'replication':
			return i18n.t('upgrades_tab.run_progress.phase_replication');
		case 'ranking':
			return i18n.t('upgrades_tab.progress.ranking');
	}
};

export const progressBarOf = (view: RunProgressView): ProgressTrackerProgress => ({ current: view.done, total: view.total });
