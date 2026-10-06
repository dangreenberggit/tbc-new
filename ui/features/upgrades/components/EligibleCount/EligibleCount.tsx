import i18n from '@i18n/config';

export interface EligibleCountProps {
	/** Undefined when the page's spec has no ranking data. */
	count: number | undefined;
}

/** How many candidates the next run sims, beside Run. */
export const EligibleCount = ({ count }: EligibleCountProps) => (
	<p className="mb-0" data-testid="upgrades-eligible-count" data-count={count}>
		{count === undefined ? i18n.t('upgrades_tab.eligible_count_unknown') : i18n.t('upgrades_tab.eligible_count', { count })}
	</p>
);
