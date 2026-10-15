import { Popover as BasePopover } from '@base-ui/react/popover';
import i18n from '@i18n/config';
import { Popover, type PopoverSide } from '@ui-kit/Popover';
import { type ReactNode, type SyntheticEvent, useState } from 'react';

import type { SetBonusTip } from '../../model/set_bonus_tip';
import { setBonusTipText, tipSections } from '../../utils/set_bonus_labels';

export interface SetBonusPopoverProps {
	tip: SetBonusTip;
	/** The DPS figure, which is the popover's trigger. */
	children: ReactNode;
}

/**
 * The popup's width cap. Tailwind generates a class only from a literal it finds in the source, so the cap is written
 * out once here and `WIDEST_REM` is read back from it.
 */
const POPUP_MAX_WIDTH = 'max-w-[min(30rem,calc(100vw-1rem))]';
const WIDEST_REM = Number(/min\((\d+(?:\.\d+)?)rem/.exec(POPUP_MAX_WIDTH)?.[1]);
/** The popup's gap to the figure, passed to the Popover as `sideOffset` so this is the one place it is set. */
const ANCHOR_GAP_PX = 10;
/**
 * How far from the window's edge Base UI's `flip()` wants the popup: its default `collisionPadding` of 5 px
 * (`useAnchorPositioning.js`, which the ui-kit Popover does not override) plus the 1 px it adds to flip's padding.
 */
const FLIP_MARGIN_PX = 5 + 1;

/**
 * Right when the widest popup fits between the figure and the window's edge, above otherwise. Measured here because
 * Base UI's own fallback for `right` is `left`, which would cover the row's item name (ticket 495).
 */
const sideFor = (figure: Element): PopoverSide => {
	const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	const windowRight = document.documentElement.clientWidth || window.innerWidth;
	const room = windowRight - figure.getBoundingClientRect().right;
	return room >= WIDEST_REM * rootPx + ANCHOR_GAP_PX + FLIP_MARGIN_PX ? 'right' : 'top';
};

/**
 * Where a row's set-bonus figure comes from: a receipt whose lines add up to
 * the figure, or a step ranking row's separate outcomes. Opens on hover, and
 * from the keyboard with Enter or Space on the figure (Base UI's trigger is a
 * button). Right of the figure when it fits, so the DPS column stays readable,
 * and above it otherwise (ticket 495). Since ticket 606 put Slot after DPS, the
 * right side covers the row's own Slot cell; the owner accepted that
 * (Q-606-popover-side).
 */
export const SetBonusPopover = ({ tip, children }: SetBonusPopoverProps) => {
	const [side, setSide] = useState<PopoverSide>('top');
	const measure = (event: SyntheticEvent<HTMLButtonElement>) => setSide(sideFor(event.currentTarget));
	return (
		<Popover
			trigger={children}
			triggerClassName="cursor-help text-inherit underline decoration-dotted underline-offset-2 [font:inherit] focus-visible:focus-ring"
			triggerProps={{ onPointerEnter: measure, onFocus: measure }}
			openOnHover
			side={side}
			sideOffset={ANCHOR_GAP_PX}
			maxWidth={POPUP_MAX_WIDTH}
			testId="upgrades-set-bonus-tip">
			<BasePopover.Title className="sr-only">{i18n.t('upgrades_tab.results.set_bonus_tip_title', { ns: 'upgrades' })}</BasePopover.Title>
			<div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-left">
				{tipSections(setBonusTipText(tip)).map(section => (
					<div key={section.id} className="contents">
						{section.heading && <p className="col-span-2 mt-1 mb-0 font-semibold">{section.heading}</p>}
						<dl className="contents">
							{section.lines.map(line => (
								<div key={line.id} className="contents" data-testid={line.total ? 'upgrades-set-bonus-tip-total' : undefined}>
									<dt className={line.total ? 'border-t border-t-border pt-0.5 font-semibold' : 'font-normal'}>
										{line.label}
										{line.marker && <small className="block text-muted">{line.marker}</small>}
									</dt>
									<dd
										className={
											line.total
												? 'm-0 border-t border-t-border pt-0.5 text-right font-semibold tabular-nums'
												: 'm-0 text-right tabular-nums'
										}>
										{line.value}
									</dd>
								</div>
							))}
						</dl>
					</div>
				))}
			</div>
		</Popover>
	);
};
