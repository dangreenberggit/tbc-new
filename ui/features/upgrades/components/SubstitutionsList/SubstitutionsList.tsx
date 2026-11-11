import i18n from '@i18n/config';

import type { Substitution } from '../../model/engine/disclosure';
import { substitutionErrorText, substitutionLabel, substitutionText } from '../../utils/format';

export interface SubstitutionsListProps {
	substitutions: readonly Substitution[];
}

/**
 * Every item the run left out, and why (ticket 156), with the run's other
 * notes: a left-out item is a reason an item the player expected is missing
 * from the list. A failed call's error shows its first line under the
 * sentence (ticket 874); the run logs the full text to the console.
 */
export const SubstitutionsList = ({ substitutions }: SubstitutionsListProps) => (
	<section className="mt-4">
		<p className="mb-1 font-bold">{i18n.t('upgrades_tab.assumptions.substitutions_title', { ns: 'upgrades', count: substitutions.length })}</p>
		<dl className="mb-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="upgrades-substitutions">
			{substitutions.map(substitution => {
				const error = substitutionErrorText(substitution.error);
				return (
					// The engine names each substitution by what it is about; the slot, detail and error tell two about one field apart.
					<div key={`${substitution.field}|${substitution.slot ?? ''}|${substitution.detail}|${substitution.error ?? ''}`} className="contents">
						<dt className="font-normal text-muted">{substitutionLabel(substitution)}</dt>
						<dd className="m-0">
							<span className="block">{substitutionText(substitution.detail)}</span>
							{error !== undefined && (
								<span className="block text-muted" data-testid="upgrades-substitution-error">
									{error}
								</span>
							)}
						</dd>
					</div>
				);
			})}
		</dl>
	</section>
);
