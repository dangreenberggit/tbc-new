import i18n from '@i18n/config';
import { FieldLabel } from '@ui-kit/FormControl';
import { type ChangeEvent, useId, useState } from 'react';

import { FIXTURE_NOT_JSON, type FixtureLoadResult } from '../../utils/fixture';
import { fixtureOutcomeText } from '../../utils/format';

/**
 * Loads a recorded fixture file from disk, for a developer with a file the
 * dev server does not serve. It hands the file to the page's own fixture
 * hook (`useFixtureAutoload`), so a file and a `?upgrades-fixture` link take
 * one path and get the same staleness signature.
 */
export const FixtureFileInput = () => {
	const inputId = useId();
	const [outcome, setOutcome] = useState<FixtureLoadResult>();
	// The switch is read here, not through `dev_flags.ts`, so a production build drops this component's body.
	if (!(import.meta.env.DEV || import.meta.env.VITE_TBC_TAB_FIXTURES === '1')) return null;

	const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file || !window.__upgradesFixture) return;
		let payload: unknown;
		try {
			payload = JSON.parse(await file.text());
		} catch {
			setOutcome({ ok: false, reason: FIXTURE_NOT_JSON });
			return;
		}
		setOutcome(await window.__upgradesFixture(payload));
	};

	return (
		<div className="grid gap-1">
			<FieldLabel htmlFor={inputId}>{i18n.t('upgrades_tab.settings.fixture_file', { ns: 'upgrades' })}</FieldLabel>
			<input id={inputId} type="file" accept=".json" data-testid="upgrades-fixture-file" onChange={onChange} />
			{outcome && (
				<p className="mb-0 text-sm text-muted" data-testid="upgrades-fixture-file-result">
					{fixtureOutcomeText(outcome)}
				</p>
			)}
		</div>
	);
};
