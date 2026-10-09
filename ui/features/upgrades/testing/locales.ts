import i18n from '@i18n/config';
import { afterAll, beforeAll } from 'vitest';

import englishCharacter from '../../../../assets/locales/en/character.json';
import englishTranslations from '../../../../assets/locales/en/translation.json';
import upgradesTranslations from '../../../../assets/locales/en/upgrades.json';

const BUNDLES = { translation: englishTranslations, upgrades: upgradesTranslations, character: englishCharacter };

/**
 * Adds the English bundles a tab test renders with before the file's tests and removes them after: `translation`
 * and `upgrades` always, `character` when the test renders a stat or slot name. The vitest i18n loader is a stub,
 * so a test that skips this sees raw keys.
 */
export const loadEnglishBundles = ({ character = false }: { character?: boolean } = {}) => {
	const namespaces = character ? (['translation', 'upgrades', 'character'] as const) : (['translation', 'upgrades'] as const);
	beforeAll(() => {
		for (const ns of namespaces) i18n.addResourceBundle('en', ns, BUNDLES[ns], true, true);
	});
	afterAll(() => {
		for (const ns of namespaces) i18n.removeResourceBundle('en', ns);
	});
};
