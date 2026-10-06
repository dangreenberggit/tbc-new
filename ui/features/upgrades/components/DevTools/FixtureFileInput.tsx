import i18n from '@i18n/config';
import { FieldLabel } from '@ui-kit/FormControl';
import { type ChangeEvent, useId, useState } from 'react';

import type { FixtureLoadResult } from '../../utils/fixture';

/** The file's own failure, before the page's hook sees it. */
const NOT_JSON = 'not_json';

const outcomeText = (outcome: FixtureLoadResult): string => {
	if (outcome.ok) return i18n.t('upgrades_tab.settings.fixture_loaded', { rows: outcome.rows });
	if (outcome.reason === NOT_JSON) return i18n.t('upgrades_tab.settings.fixture_not_json');
	return i18n.t('upgrades_tab.settings.fixture_rejected', { reason: outcome.detail ?? outcome.reason });
};

/**
 * Loads a recorded fixture file from disk, for a developer with a file the
 * dev server does not serve. It hands the file to the page's own fixture
 * hook (`useFixtureAutoload`), so a file and a `?upgrades-fixture` link take
 * one path and get the same staleness signature.
 */
export const FixtureFileInput = () => {
	const inputId = useId();
	const [outcome, setOutcome] = useState<FixtureLoadResult>();
	// The define is read here, not through `dev_flags.ts`, so a production build drops this component's body.
	if (!(typeof __TBC_TAB_FIXTURES__ !== 'undefined' && __TBC_TAB_FIXTURES__)) return null;

	const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (!file || !window.__upgradesFixture) return;
		let payload: unknown;
		try {
			payload = JSON.parse(await file.text());
		} catch {
			setOutcome({ ok: false, reason: NOT_JSON });
			return;
		}
		setOutcome(await window.__upgradesFixture(payload));
	};

	return (
		<div className="grid gap-1">
			<FieldLabel htmlFor={inputId}>{i18n.t('upgrades_tab.settings.fixture_file')}</FieldLabel>
			<input id={inputId} type="file" accept=".json" data-testid="upgrades-fixture-file" onChange={onChange} />
			{outcome && (
				<p className="mb-0 text-sm text-muted" data-testid="upgrades-fixture-file-result">
					{outcomeText(outcome)}
				</p>
			)}
		</div>
	);
};
