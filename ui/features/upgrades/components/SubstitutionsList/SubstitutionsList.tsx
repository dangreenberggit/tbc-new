import i18n from '@i18n/config';

import { substitutionFirstLine } from '../../model/assumptions';
import type { Substitution } from '../../model/engine/disclosure';

export interface SubstitutionsListProps {
	substitutions: readonly Substitution[];
}

const shownDetail = (detail: string): string => {
	const { line, truncated } = substitutionFirstLine(detail);
	return truncated ? `${line}${i18n.t('upgrades_tab.assumptions.substitution_truncated_suffix')}` : line;
};

/**
 * Every candidate the run dropped, and why (ticket 156): a dropped candidate
 * is a reason an item the player expected is missing from the list. A crash
 * trace shows its first line; the run logs the full text to the console.
 */
export const SubstitutionsList = ({ substitutions }: SubstitutionsListProps) => (
	<section className="mt-4">
		<p className="mb-1 font-bold">{i18n.t('upgrades_tab.assumptions.substitutions_title', { count: substitutions.length })}</p>
		<dl className="mb-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="upgrades-substitutions">
			{substitutions.map(substitution => (
				<div key={substitution.field} className="contents">
					<dt className="font-normal text-muted">{substitution.field}</dt>
					<dd className="m-0">{shownDetail(substitution.detail)}</dd>
				</div>
			))}
		</dl>
	</section>
);
