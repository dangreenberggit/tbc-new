import i18n from '@i18n/config';

import type { BonusRef, SetBonusTip, TipLabel } from '../model/set_bonus_tip';

/** One printed popover row. `total` marks the receipt's last line. */
export type TipTextRow = { type: 'heading'; text: string } | { type: 'line'; label: string; value: string; marker?: string; total: boolean };

/**
 * Joins names as "A", "A and B", or "A, B and C". Literal English, as the old
 * tab had it; the `set_bonus` keys carry no list pattern.
 */
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** "{set} {count}pc", with the no-break space the `tip_*` keys use, so a count never wraps away from its set. */
const brokenNames = (lost: readonly BonusRef[]): string => joinNames(lost.map(b => `${b.setName} ${b.threshold}pc`));

export const setBonusSubLineText = (subLine: SetBonusTip['subLine']): string =>
	subLine === 'not_counted' ? i18n.t('upgrades_tab.set_bonus.not_counted') : i18n.t('upgrades_tab.set_bonus.hover_hint');

const itemStatsText = (label: Extract<TipLabel, { kind: 'item_stats' }>): string => {
	let text: string | null = label.bonus
		? i18n.t('upgrades_tab.set_bonus.tip_item_stats_with_bonus', { set: label.bonus.setName, threshold: label.bonus.threshold })
		: null;
	for (const b of label.unmeasuredBreaks) {
		text =
			text === null
				? i18n.t('upgrades_tab.set_bonus.tip_item_stats_with_broken', { set: b.setName, threshold: b.threshold })
				: i18n.t('upgrades_tab.set_bonus.tip_item_stats_add_broken', { label: text, set: b.setName, threshold: b.threshold });
	}
	return text ?? i18n.t('upgrades_tab.set_bonus.tip_item_stats');
};

const piecesText = (label: Extract<TipLabel, { kind: 'pieces' }>): string => {
	const pieces = joinNames(label.pieces);
	const { threshold } = label;
	if (label.broken.length === 0) {
		return label.form === 'stop'
			? i18n.t('upgrades_tab.set_bonus.tip_stop', { pieces, threshold })
			: i18n.t('upgrades_tab.set_bonus.tip_step', { pieces, threshold });
	}
	const broken = brokenNames(label.broken);
	return label.form === 'stop'
		? i18n.t('upgrades_tab.set_bonus.tip_stop_breaks', { pieces, threshold, broken })
		: i18n.t('upgrades_tab.set_bonus.tip_step_breaks', { pieces, threshold, broken });
};

export function tipLabelText(label: TipLabel): string {
	switch (label.kind) {
		case 'item_stats':
			return itemStatsText(label);
		case 'breaks': {
			const [only] = label.broken;
			return label.broken.length === 1 && only
				? i18n.t('upgrades_tab.set_bonus.tip_breaks', { set: only.setName, threshold: only.threshold })
				: i18n.t('upgrades_tab.set_bonus.tip_breaks_several', { broken: brokenNames(label.broken) });
		}
		case 'bonus':
			return i18n.t('upgrades_tab.set_bonus.tip_bonus', { set: label.set, threshold: label.threshold, have: label.have });
		case 'piece_stats':
			return i18n.t('upgrades_tab.set_bonus.tip_piece_stats', { name: label.name });
		case 'pieces':
			return piecesText(label);
		case 'item_alone':
			return label.broken.length === 0
				? i18n.t('upgrades_tab.set_bonus.tip_item_alone', { name: label.name })
				: i18n.t('upgrades_tab.set_bonus.tip_item_alone_breaks', { name: label.name, broken: brokenNames(label.broken) });
		case 'total':
			return i18n.t('upgrades_tab.set_bonus.tip_total');
	}
}

/**
 * A receipt figure is signed, with no unit (the column says DPS). An outcome
 * is "N DPS more" or "N DPS less" with no sign, because outcomes are not
 * added to anything.
 */
const valueText = (kind: SetBonusTip['kind'], dps: number | undefined): string => {
	if (dps === undefined) return i18n.t('upgrades_tab.set_bonus.tip_couldnt_measure');
	if (kind === 'receipt') return `${dps > 0 ? '+' : ''}${dps.toFixed(1)}`;
	const shown = Number(dps.toFixed(1));
	const amount = Math.abs(shown).toFixed(1);
	return shown < 0 ? i18n.t('upgrades_tab.set_bonus.tip_dps_less', { dps: amount }) : i18n.t('upgrades_tab.set_bonus.tip_dps_more', { dps: amount });
};

export const setBonusTipText = (tip: SetBonusTip): TipTextRow[] =>
	tip.entries.map((entry): TipTextRow => {
		if (entry.type === 'heading') {
			return {
				type: 'heading',
				text:
					entry.heading === 'set_potential'
						? i18n.t('upgrades_tab.set_bonus.tip_set_potential')
						: i18n.t('upgrades_tab.set_bonus.tip_set_potential_totals'),
			};
		}
		return {
			type: 'line',
			label: tipLabelText(entry.label),
			value: valueText(tip.kind, entry.dps),
			...(entry.marker ? { marker: i18n.t('upgrades_tab.set_bonus.tip_figure_marker') } : {}),
			total: entry.label.kind === 'total',
		};
	});
