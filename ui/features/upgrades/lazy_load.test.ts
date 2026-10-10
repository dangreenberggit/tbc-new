// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FEATURE = path.join(UI, 'features', 'upgrades');

/** Every module specifier a file imports statically. `import type` is erased at build and `import()` is the lazy path. */
const staticImports = (source: string): string[] => {
	const specifiers: string[] = [];
	const fromClause = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gms;
	const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
	for (const match of source.matchAll(fromClause)) specifiers.push(match[1]);
	for (const match of source.matchAll(bare)) specifiers.push(match[1]);
	return specifiers;
};

const resolvesIntoFeature = (file: string, specifier: string): boolean => {
	if (specifier === '@features/upgrades' || specifier.startsWith('@features/upgrades/')) return true;
	if (!specifier.startsWith('.')) return false;
	const target = path.resolve(path.dirname(file), specifier);
	return target === FEATURE || target.startsWith(FEATURE + path.sep);
};

/**
 * The feature files the eager tab body may import statically, to record phase changes from page start (ticket
 * 587). Each must import nothing else from the feature, so it brings in neither the tab's code nor its data.
 */
const EAGER_FILES = ['model/phase_changes.ts'];
const EAGER_SPECIFIERS = new Set(EAGER_FILES.map(file => `@features/upgrades/${file.replace(/\.ts$/, '')}`));

const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return full === FEATURE ? [] : sourceFiles(full);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
	});

/**
 * The tab's code and its bundled item data must stay out of every spec page's first download: the only way in from
 * outside the feature is the `import()` in `ui/app/tabs/UpgradesTabBody.tsx`. A static import anywhere else would pass
 * every render test and put the whole chunk back on each page.
 */
describe('the Upgrades feature loads lazily', () => {
	it('is imported statically by no production file outside its folder', () => {
		const offenders = sourceFiles(UI).flatMap(file =>
			staticImports(readFileSync(file, 'utf8'))
				.filter(specifier => resolvesIntoFeature(file, specifier) && !EAGER_SPECIFIERS.has(specifier))
				.map(specifier => `${path.relative(UI, file).split(path.sep).join('/')}: ${specifier}`),
		);
		expect(offenders).toEqual([]);
	});

	it.each(EAGER_FILES)('lets %s, which the tab body imports statically, import nothing else from the feature', file => {
		const full = path.join(FEATURE, file);
		expect(staticImports(readFileSync(full, 'utf8')).filter(specifier => resolvesIntoFeature(full, specifier))).toEqual([]);
	});

	it('is reached through the tab body’s dynamic import', () => {
		const tabBody = readFileSync(path.join(UI, 'app', 'tabs', 'UpgradesTabBody.tsx'), 'utf8');
		expect(tabBody).toMatch(/import\(\s*'@features\/upgrades\//);
	});

	it('finds the static import forms the bundler follows', () => {
		const source = [
			"import { A } from '@features/upgrades/a';",
			'import {',
			'\tB,',
			"} from '@features/upgrades/b';",
			"import '@features/upgrades/c';",
			"export { D } from '@features/upgrades/d';",
			"import { type E, F } from '@features/upgrades/e';",
			"import type { G } from '@features/upgrades/g';",
			"const H = lazy(() => import('@features/upgrades/h'));",
		].join('\n');
		expect(staticImports(source)).toEqual([
			'@features/upgrades/a',
			'@features/upgrades/b',
			'@features/upgrades/d',
			'@features/upgrades/e',
			'@features/upgrades/c',
		]);
	});
});
