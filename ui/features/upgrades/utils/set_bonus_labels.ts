import i18n from '@i18n/config';

import type { BonusRef, ScreenedReason, SetBonusTip, TipEntry, TipLabel } from '../model/set_bonus_tip';

/**
 * One printed popover row. `id` names what the row is about, for a list key;
 * `total` marks the receipt's last line; `muted` marks a line the figure does
 * not count.
 */
export type TipTextRow =
	| { type: 'heading'; id: string; text: string }
	| { type: 'line'; id: string; label: string; value: string; marker?: string; total: boolean; muted?: boolean };

/**
 * Joins names as "A", "A and B", or "A, B and C". Literal English, as the old
 * tab had it; the `set_bonus` keys carry no list pattern.
 */
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** "{set} {count}pc", with the no-break space the `tip_*` keys use, so a count never wraps away from its set. */
const brokenNames = (lost: readonly BonusRef[]): string => joinNames(lost.map(b => `${b.setName} ${b.threshold}pc`));

export const setBonusSubLineText = (subLine: SetBonusTip['subLine']): string =>
	subLine === 'not_counted'
		? i18n.t('upgrades_tab.set_bonus.not_counted', { ns: 'upgrades' })
		: i18n.t('upgrades_tab.set_bonus.hover_hint', { ns: 'upgrades' });

const itemStatsText = (label: Extract<TipLabel, { kind: 'item_stats' }>): string => {
	let text: string | null = label.bonus
		? i18n.t('upgrades_tab.set_bonus.tip_item_stats_with_bonus', { ns: 'upgrades', set: label.bonus.setName, threshold: label.bonus.threshold })
		: null;
	for (const b of label.unmeasuredBreaks) {
		text =
			text === null
				? i18n.t('upgrades_tab.set_bonus.tip_item_stats_with_broken', { ns: 'upgrades', set: b.setName, threshold: b.threshold })
				: i18n.t('upgrades_tab.set_bonus.tip_item_stats_add_broken', { ns: 'upgrades', label: text, set: b.setName, threshold: b.threshold });
	}
	return text ?? i18n.t('upgrades_tab.set_bonus.tip_item_stats', { ns: 'upgrades' });
};

const piecesText = (label: Extract<TipLabel, { kind: 'pieces' }>): string => {
	const pieces = joinNames(label.pieces);
	const { threshold } = label;
	if (label.broken.length === 0) {
		return label.form === 'stop'
			? i18n.t('upgrades_tab.set_bonus.tip_stop', { ns: 'upgrades', pieces, threshold })
			: i18n.t('upgrades_tab.set_bonus.tip_step', { ns: 'upgrades', pieces, threshold });
	}
	const broken = brokenNames(label.broken);
	return label.form === 'stop'
		? i18n.t('upgrades_tab.set_bonus.tip_stop_breaks', { ns: 'upgrades', pieces, threshold, broken })
		: i18n.t('upgrades_tab.set_bonus.tip_step_breaks', { ns: 'upgrades', pieces, threshold, broken });
};

export function tipLabelText(label: TipLabel): string {
	switch (label.kind) {
		case 'item_stats':
			return itemStatsText(label);
		case 'breaks': {
			const [only] = label.broken;
			return label.broken.length === 1 && only
				? i18n.t('upgrades_tab.set_bonus.tip_breaks', { ns: 'upgrades', set: only.setName, threshold: only.threshold })
				: i18n.t('upgrades_tab.set_bonus.tip_breaks_several', { ns: 'upgrades', broken: brokenNames(label.broken) });
		}
		case 'bonus':
			return i18n.t('upgrades_tab.set_bonus.tip_bonus', { ns: 'upgrades', set: label.set, threshold: label.threshold, have: label.have });
		case 'piece_stats':
			return i18n.t('upgrades_tab.set_bonus.tip_piece_stats', { ns: 'upgrades', name: label.name });
		case 'pieces':
			return piecesText(label);
		case 'item_alone':
			return label.broken.length === 0
				? i18n.t('upgrades_tab.set_bonus.tip_item_alone', { ns: 'upgrades', name: label.name })
				: i18n.t('upgrades_tab.set_bonus.tip_item_alone_breaks', { ns: 'upgrades', name: label.name, broken: brokenNames(label.broken) });
		case 'reachable': {
			// A step ranking drops a future's pieces when no partner choice was measured, leaving no pieces to name.
			if (label.pieces.length === 0)
				return i18n.t('upgrades_tab.set_bonus.tip_reachable_bonus', { ns: 'upgrades', set: label.set, threshold: label.threshold });
			const args = { set: label.set, threshold: label.threshold, pieces: joinNames(label.pieces) };
			return label.broken.length === 0
				? i18n.t('upgrades_tab.set_bonus.tip_reachable', { ns: 'upgrades', ...args })
				: i18n.t('upgrades_tab.set_bonus.tip_reachable_breaks', { ns: 'upgrades', ...args, broken: brokenNames(label.broken) });
		}
		case 'screened':
			return i18n.t('upgrades_tab.set_bonus.tip_screened', { ns: 'upgrades', set: label.set });
		case 'total':
			return i18n.t('upgrades_tab.set_bonus.tip_total', { ns: 'upgrades' });
	}
}

/** What the set screen found, in place of a figure (ticket 336). */
const screenedValueText = (reason: ScreenedReason): string => {
	switch (reason) {
		case 'outside-band':
			return i18n.t('upgrades_tab.set_bonus.tip_screened_unmeasured', { ns: 'upgrades' });
		case 'exact-zero':
			return i18n.t('upgrades_tab.set_bonus.tip_screened_no_effect', { ns: 'upgrades' });
		case 'below-zero':
			return i18n.t('upgrades_tab.set_bonus.tip_screened_loss', { ns: 'upgrades' });
	}
};

/**
 * A receipt figure is signed, with no unit (the column says DPS). An outcome
 * is "N DPS more" or "N DPS less" with no sign, because outcomes are not
 * added to anything.
 */
const valueText = (kind: SetBonusTip['kind'], entry: Extract<TipEntry, { type: 'line' }>): string => {
	const { dps } = entry;
	if (entry.label.kind === 'screened') return screenedValueText(entry.label.reason);
	if (dps === undefined) return i18n.t('upgrades_tab.set_bonus.tip_couldnt_measure', { ns: 'upgrades' });
	if (kind === 'receipt' && !entry.outcome) return `${dps > 0 ? '+' : ''}${dps.toFixed(1)}`;
	const shown = Number(dps.toFixed(1));
	const amount = Math.abs(shown).toFixed(1);
	return shown < 0
		? i18n.t('upgrades_tab.set_bonus.tip_dps_less', { ns: 'upgrades', dps: amount })
		: i18n.t('upgrades_tab.set_bonus.tip_dps_more', { ns: 'upgrades', dps: amount });
};

const bonusIds = (bonuses: readonly BonusRef[]): string => bonuses.map(b => `${b.setName}:${b.threshold}`).join('+');

/** What a popover line is about, from its data rather than its printed text. */
export function tipLabelId(label: TipLabel): string {
	switch (label.kind) {
		case 'item_stats':
		case 'item_alone':
		case 'total':
			return label.kind;
		case 'breaks':
			return `breaks:${bonusIds(label.broken)}`;
		case 'bonus':
			return `bonus:${label.set}:${label.threshold}`;
		case 'piece_stats':
			return `piece:${label.name}`;
		case 'pieces':
			return `pieces:${label.form}:${label.threshold}:${label.pieces.join('+')}`;
		case 'reachable':
			return `reachable:${label.set}:${label.threshold}`;
		case 'screened':
			return `screened:${label.set}`;
	}
}

const HEADING_KEYS = {
	set_potential: 'tip_set_potential',
	set_potential_totals: 'tip_set_potential_totals',
	not_counted_off: 'tip_not_counted_off',
	not_counted_no_gain: 'tip_not_counted_no_gain',
	not_counted: 'tip_not_counted',
} as const satisfies Record<Extract<TipEntry, { type: 'heading' }>['heading'], string>;

export const setBonusTipText = (tip: SetBonusTip): TipTextRow[] => {
	// Nothing in the model forbids two lines about the same thing, so a repeat gets its occurrence number.
	const seen = new Map<string, number>();
	const unique = (id: string) => {
		const count = (seen.get(id) ?? 0) + 1;
		seen.set(id, count);
		return count === 1 ? id : `${id}#${count}`;
	};
	return tip.entries.map((entry): TipTextRow => {
		if (entry.type === 'heading') {
			return {
				type: 'heading',
				id: unique(entry.heading),
				text: i18n.t(`upgrades_tab.set_bonus.${HEADING_KEYS[entry.heading]}`, { ns: 'upgrades' }),
			};
		}
		return {
			type: 'line',
			id: unique(tipLabelId(entry.label)),
			label: tipLabelText(entry.label),
			value: valueText(tip.kind, entry),
			...(entry.marker ? { marker: i18n.t('upgrades_tab.set_bonus.tip_figure_marker', { ns: 'upgrades' }) } : {}),
			total: entry.label.kind === 'total',
			...(entry.outcome || entry.label.kind === 'screened' ? { muted: true } : {}),
		};
	});
};

export type TipLineRow = Extract<TipTextRow, { type: 'line' }>;

/** The popover's lines grouped under their headings; lines before the first heading form an untitled section, id `lines`. */
export type TipSection = { id: string; heading?: string; lines: TipLineRow[] };

export function tipSections(rows: readonly TipTextRow[]): TipSection[] {
	const sections: TipSection[] = [];
	for (const row of rows) {
		if (row.type === 'heading') {
			sections.push({ id: row.id, heading: row.text, lines: [] });
			continue;
		}
		const last = sections.at(-1);
		if (last) last.lines.push(row);
		else sections.push({ id: 'lines', lines: [row] });
	}
	return sections;
}
