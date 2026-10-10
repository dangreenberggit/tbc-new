// @vitest-environment node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FEATURE = path.join(UI, 'features', 'upgrades');
const TAB_BODY = path.join(UI, 'app', 'tabs', 'UpgradesTabBody.tsx');

/** Every module specifier a file imports statically. `import type` is erased at build and `import()` is the lazy path. */
const staticImports = (source: string): string[] => {
	const specifiers: string[] = [];
	const fromClause = /^\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gms;
	const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
	for (const match of source.matchAll(fromClause)) specifiers.push(match[1]);
	for (const match of source.matchAll(bare)) specifiers.push(match[1]);
	return specifiers;
};

const dynamicImports = (source: string): string[] => [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);

/** The path aliases of the fork's `tsconfig.json`. */
const ALIASES: Record<string, string> = {
	'@sim/': 'sim',
	'@generated/': 'generated',
	'@worker/': 'worker',
	'@ui-kit/': 'ui-kit',
	'@features/': 'features',
	'@app/': 'app',
	'@specs/': 'specs',
	'@i18n/': 'i18n',
};
const SOURCE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

/** The source file a specifier names, or undefined for a package, an asset or a JSON file. */
const resolveSource = (file: string, specifier: string): string | undefined => {
	const alias = Object.keys(ALIASES).find(prefix => specifier.startsWith(prefix));
	let base: string | undefined;
	if (alias) base = path.join(UI, ALIASES[alias], specifier.slice(alias.length));
	else if (specifier.startsWith('.')) base = path.resolve(path.dirname(file), specifier);
	if (!base) return undefined;
	if (/\.tsx?$/.test(base) && existsSync(base)) return base;
	return SOURCE_SUFFIXES.map(suffix => base + suffix).find(candidate => existsSync(candidate));
};

/** Every source file the bundler puts in the same download as `entry`: its static imports, followed to the end. */
const staticallyReached = (entry: string): Set<string> => {
	const reached = new Set<string>();
	const pending = [entry];
	while (pending.length) {
		const file = pending.pop()!;
		for (const specifier of staticImports(readFileSync(file, 'utf8'))) {
			const target = resolveSource(file, specifier);
			if (target && !reached.has(target)) {
				reached.add(target);
				pending.push(target);
			}
		}
	}
	return reached;
};

const resolvesIntoFeature = (file: string, specifier: string): boolean => {
	if (specifier === '@features/upgrades' || specifier.startsWith('@features/upgrades/')) return true;
	if (!specifier.startsWith('.')) return false;
	const target = path.resolve(path.dirname(file), specifier);
	return target === FEATURE || target.startsWith(FEATURE + path.sep);
};

/**
 * The feature files the eager tab body may import statically, to save phase changes from page start (tickets 587,
 * 589). Each imports nothing from the feature but another of them, so they bring in neither the tab's code nor its data.
 */
const EAGER_FILES = ['model/phase_changes.ts', 'model/saved_entry.ts'];
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

	it.each(EAGER_FILES)('lets %s, which the tab body reaches statically, import nothing from the feature but the eager files', file => {
		const full = path.join(FEATURE, file);
		const eager = new Set(EAGER_FILES.map(name => path.join(FEATURE, name)));
		const imported = staticImports(readFileSync(full, 'utf8')).filter(specifier => resolvesIntoFeature(full, specifier));
		expect(imported.filter(specifier => !eager.has(resolveSource(full, specifier) ?? specifier))).toEqual([]);
	});

	it('is reached through the tab body’s dynamic import', () => {
		const tabBody = readFileSync(TAB_BODY, 'utf8');
		expect(tabBody).toMatch(/import\(\s*'@features\/upgrades\//);
	});

	// A phase change made while the tab is closed must not download the tab's data (ticket 589).
	it('is downloaded by the tab body only when the tab opens', () => {
		expect(dynamicImports(readFileSync(TAB_BODY, 'utf8'))).toEqual(['@features/upgrades/components/UpgradesTab']);
	});

	it('reaches, from the tab body’s static imports, no feature file but the eager ones, so not the tab’s data', () => {
		const reachedInFeature = [...staticallyReached(TAB_BODY)]
			.filter(file => file.startsWith(FEATURE + path.sep))
			.map(file => path.relative(FEATURE, file).split(path.sep).join('/'))
			.sort();
		expect(reachedInFeature).toEqual([...EAGER_FILES].sort());
		expect(reachedInFeature).not.toContain('model/data/data.ts');
	});

	// Without this the check above would pass for a walk that stops too early.
	it('follows static imports far enough to find the data: the tab’s store reaches it', () => {
		expect(staticallyReached(path.join(FEATURE, 'hooks', 'useUpgradesStore.ts'))).toContain(path.join(FEATURE, 'model', 'data', 'data.ts'));
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
