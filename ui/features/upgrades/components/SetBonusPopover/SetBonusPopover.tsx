import { Popover } from '@ui-kit/Popover';
import type { ReactNode } from 'react';

import type { SetBonusTip } from '../../model/set_bonus_tip';
import { setBonusTipText, tipSections } from '../../utils/set_bonus_labels';

export interface SetBonusPopoverProps {
	tip: SetBonusTip;
	/** The DPS figure, which is the popover's trigger. */
	children: ReactNode;
}

/**
 * Where a row's set-bonus figure comes from: a receipt whose lines add up to
 * the figure, or a step ranking row's separate outcomes. Opens on hover, and
 * from the keyboard with Enter or Space on the figure (Base UI's trigger is a
 * button). Right of the figure, so the DPS column stays readable (ticket 495).
 */
export const SetBonusPopover = ({ tip, children }: SetBonusPopoverProps) => (
	<Popover
		trigger={children}
		triggerClassName="cursor-help text-inherit underline decoration-dotted underline-offset-2 [font:inherit] focus-visible:focus-ring"
		openOnHover
		side="right"
		maxWidth="max-w-[min(30rem,var(--available-width))]"
		testId="upgrades-set-bonus-tip">
		<div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 text-left">
			{tipSections(setBonusTipText(tip)).map(section => (
				<dl key={section.heading ?? ''} className="contents">
					{section.heading && <p className="col-span-2 mt-1 mb-0 font-semibold">{section.heading}</p>}
					{section.lines.map(line => (
						<div key={line.label} className="contents" data-testid={line.total ? 'upgrades-set-bonus-tip-total' : undefined}>
							<dt className={line.total ? 'border-t border-t-border pt-0.5 font-semibold' : 'font-normal'}>
								{line.label}
								{line.marker && <small className="block text-muted">{line.marker}</small>}
							</dt>
							<dd
								className={
									line.total ? 'm-0 border-t border-t-border pt-0.5 text-right font-semibold tabular-nums' : 'm-0 text-right tabular-nums'
								}>
								{line.value}
							</dd>
						</div>
					))}
				</dl>
			))}
		</div>
	</Popover>
);
