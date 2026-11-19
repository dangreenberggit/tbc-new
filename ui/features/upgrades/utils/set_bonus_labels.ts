import i18n from '@i18n/config';

import type { BonusRef, PopoverEntry, PopoverLabel, ScreenedReason, SetBonusPopoverContent } from '../model/set_bonus_popover';

/**
 * One printed popover row. `id` names what the row is about, for a list key; `total`
 * marks the last line of a `receipt` popover; `muted` marks a line the figure does not count.
 */
export type PopoverTextRow =
	| { type: 'heading'; id: string; text: string }
	| { type: 'line'; id: string; label: string; value: string; marker?: string; total: boolean; muted?: boolean };

/** Joins names as "A", "A and B", or "A, B and C", in literal English: the `set_bonus` keys carry no list pattern. */
const joinNames = (names: readonly string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** "{set} {count}pc", with the no-break space the `popover_*` keys use, so a count never wraps away from its set. */
const brokenNames = (lost: readonly BonusRef[]): string => joinNames(lost.map(b => `${b.setName} ${b.threshold}pc`));

export const setBonusSubLineText = (subLine: SetBonusPopoverContent['subLine']): string =>
	subLine === 'not_counted'
		? i18n.t('upgrades_tab.set_bonus.not_counted', { ns: 'upgrades' })
		: i18n.t('upgrades_tab.set_bonus.hover_hint', { ns: 'upgrades' });

const itemStatsText = (label: Extract<PopoverLabel, { kind: 'item_stats' }>): string => {
	let text: string | null = label.bonus
		? i18n.t('upgrades_tab.set_bonus.popover_item_stats_with_bonus', { ns: 'upgrades', set: label.bonus.setName, threshold: label.bonus.threshold })
		: null;
	for (const b of label.unmeasuredBreaks) {
		text =
			text === null
				? i18n.t('upgrades_tab.set_bonus.popover_item_stats_with_broken', { ns: 'upgrades', set: b.setName, threshold: b.threshold })
				: i18n.t('upgrades_tab.set_bonus.popover_item_stats_add_broken', { ns: 'upgrades', label: text, set: b.setName, threshold: b.threshold });
	}
	return text ?? i18n.t('upgrades_tab.set_bonus.popover_item_stats', { ns: 'upgrades' });
};

const piecesText = (label: Extract<PopoverLabel, { kind: 'pieces' }>): string => {
	const pieces = joinNames(label.pieces);
	const { threshold } = label;
	if (label.broken.length === 0) {
		return label.form === 'outcome'
			? i18n.t('upgrades_tab.set_bonus.popover_outcome', { ns: 'upgrades', pieces, threshold })
			: i18n.t('upgrades_tab.set_bonus.popover_increment', { ns: 'upgrades', pieces, threshold });
	}
	const broken = brokenNames(label.broken);
	return label.form === 'outcome'
		? i18n.t('upgrades_tab.set_bonus.popover_outcome_breaks', { ns: 'upgrades', pieces, threshold, broken })
		: i18n.t('upgrades_tab.set_bonus.popover_increment_breaks', { ns: 'upgrades', pieces, threshold, broken });
};

export function popoverLabelText(label: PopoverLabel): string {
	switch (label.kind) {
		case 'item_stats':
			return itemStatsText(label);
		case 'breaks': {
			const [only] = label.broken;
			return label.broken.length === 1 && only
				? i18n.t('upgrades_tab.set_bonus.popover_breaks', { ns: 'upgrades', set: only.setName, threshold: only.threshold })
				: i18n.t('upgrades_tab.set_bonus.popover_breaks_several', { ns: 'upgrades', broken: brokenNames(label.broken) });
		}
		case 'bonus':
			return i18n.t('upgrades_tab.set_bonus.popover_bonus', { ns: 'upgrades', set: label.set, threshold: label.threshold, have: label.worn });
		case 'piece_stats':
			return i18n.t('upgrades_tab.set_bonus.popover_piece_stats', { ns: 'upgrades', name: label.name });
		case 'pieces':
			return piecesText(label);
		case 'item_alone':
			return label.broken.length === 0
				? i18n.t('upgrades_tab.set_bonus.popover_item_alone', { ns: 'upgrades', name: label.name })
				: i18n.t('upgrades_tab.set_bonus.popover_item_alone_breaks', { ns: 'upgrades', name: label.name, broken: brokenNames(label.broken) });
		case 'reachable': {
			// A `bonusGearMeasured` run leaves `pieces` empty when it measured no choice of the set's other pieces.
			if (label.pieces.length === 0)
				return i18n.t('upgrades_tab.set_bonus.popover_reachable_bonus', { ns: 'upgrades', set: label.set, threshold: label.threshold });
			const args = { set: label.set, threshold: label.threshold, pieces: joinNames(label.pieces) };
			return label.broken.length === 0
				? i18n.t('upgrades_tab.set_bonus.popover_reachable', { ns: 'upgrades', ...args })
				: i18n.t('upgrades_tab.set_bonus.popover_reachable_breaks', { ns: 'upgrades', ...args, broken: brokenNames(label.broken) });
		}
		case 'screened':
			return i18n.t('upgrades_tab.set_bonus.popover_screened', { ns: 'upgrades', set: label.set });
		case 'noise':
			return i18n.t('upgrades_tab.set_bonus.popover_reachable_bonus', { ns: 'upgrades', set: label.set, threshold: label.threshold });
		case 'total':
			return i18n.t('upgrades_tab.set_bonus.popover_total', { ns: 'upgrades' });
	}
}

/** What `setScreen` found for the set, shown in place of a figure. */
const screenedValueText = (reason: ScreenedReason): string => {
	switch (reason) {
		case 'outside-band':
			return i18n.t('upgrades_tab.set_bonus.popover_screened_unmeasured', { ns: 'upgrades' });
		case 'exact-zero':
			return i18n.t('upgrades_tab.set_bonus.popover_screened_no_effect', { ns: 'upgrades' });
		case 'below-zero':
			return i18n.t('upgrades_tab.set_bonus.popover_screened_loss', { ns: 'upgrades' });
	}
};

/**
 * A `receipt` line that is not an outcome is signed, with no unit (the column says DPS),
 * as is an `againstCreditedGear` line, which shows the piece's own amount even when negative.
 * Any other outcome is "N DPS more" or "N DPS less" with no sign, since outcomes are
 * not added up.
 */
const valueText = (kind: SetBonusPopoverContent['kind'], entry: Extract<PopoverEntry, { type: 'line' }>): string => {
	const { dps } = entry;
	if (entry.label.kind === 'screened') return screenedValueText(entry.label.reason);
	if (entry.label.kind === 'noise' || entry.belowNoise) return i18n.t('upgrades_tab.set_bonus.popover_too_small', { ns: 'upgrades' });
	if (dps === undefined) return i18n.t('upgrades_tab.set_bonus.popover_couldnt_measure', { ns: 'upgrades' });
	if ((kind === 'receipt' && !entry.outcome) || entry.againstCreditedGear) return `${dps > 0 ? '+' : ''}${dps.toFixed(1)}`;
	const shown = Number(dps.toFixed(1));
	const amount = Math.abs(shown).toFixed(1);
	return shown < 0
		? i18n.t('upgrades_tab.set_bonus.popover_dps_less', { ns: 'upgrades', dps: amount })
		: i18n.t('upgrades_tab.set_bonus.popover_dps_more', { ns: 'upgrades', dps: amount });
};

const bonusesKey = (bonuses: readonly BonusRef[]): string => bonuses.map(b => `${b.setName}:${b.threshold}`).join('+');

/** What a popover line is about, from its data rather than its printed text. */
export function popoverLabelId(label: PopoverLabel): string {
	switch (label.kind) {
		case 'item_stats':
		case 'item_alone':
		case 'total':
			return label.kind;
		case 'breaks':
			return `breaks:${bonusesKey(label.broken)}`;
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
		case 'noise':
			return `noise:${label.set}:${label.threshold}`;
	}
}

const HEADING_KEYS = {
	set_potential: 'popover_set_potential',
	set_potential_totals: 'popover_set_potential_totals',
	not_counted_off: 'popover_not_counted_off',
	not_counted_no_gain: 'popover_not_counted_no_gain',
	not_counted: 'popover_not_counted',
} as const satisfies Record<Extract<PopoverEntry, { type: 'heading' }>['heading'], string>;

export const setBonusPopoverText = (popover: SetBonusPopoverContent): PopoverTextRow[] => {
	// Nothing in the model forbids two lines about the same thing, so a repeat gets its occurrence number.
	const seen = new Map<string, number>();
	const unique = (id: string) => {
		const count = (seen.get(id) ?? 0) + 1;
		seen.set(id, count);
		return count === 1 ? id : `${id}#${count}`;
	};
	return popover.entries.map((entry): PopoverTextRow => {
		if (entry.type === 'heading') {
			return {
				type: 'heading',
				id: unique(entry.heading),
				text: i18n.t(`upgrades_tab.set_bonus.${HEADING_KEYS[entry.heading]}`, { ns: 'upgrades' }),
			};
		}
		return {
			type: 'line',
			id: unique(popoverLabelId(entry.label)),
			label: popoverLabelText(entry.label),
			value: valueText(popover.kind, entry),
			...(entry.marker ? { marker: i18n.t('upgrades_tab.set_bonus.popover_figure_marker', { ns: 'upgrades' }) } : {}),
			total: entry.label.kind === 'total',
			...(entry.outcome || entry.label.kind === 'screened' || entry.label.kind === 'noise' ? { muted: true } : {}),
		};
	});
};

export type PopoverLineRow = Extract<PopoverTextRow, { type: 'line' }>;

/** The popover's lines grouped under their headings; lines before the first heading form an untitled section, id `lines`. */
export type PopoverSection = { id: string; heading?: string; lines: PopoverLineRow[] };

export function popoverSections(rows: readonly PopoverTextRow[]): PopoverSection[] {
	const sections: PopoverSection[] = [];
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
