// Export per-spec equip eligibility by running the fork's own canEquipItem
// (ui/core/proto_utils/utils.ts) over the fork's own item database
// (assets/database/db.json, parsed with the fork's own UIDatabase.fromJson).
//
// The outer repo (tbc-gear-prio) commits the output and consumes it in
// scripts/assemble_universe.py instead of re-implementing the equip rules in
// Python -- a re-implementation that drifted and offered a rogue a two-handed
// sword the sim's own gear picker refuses (ticket 301).
//
// Nothing here decides equip legality. Every answer comes from canEquipItem.
// Keys are the fork's own PlayerSpecs names, so the committed JSON speaks the
// fork's vocabulary rather than inventing a third one.
//
// Run from the fork root (see tools/README.md for the exact command).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installBrowserShims } from './headless.mts';

installBrowserShims();

// Imported after the shims are installed: these modules touch browser globals
// at module-evaluation time (see headless.mts).
const { PlayerSpecs } = await import('../../../../player_specs/index.js');
const { UIDatabase } = await import('../../../../proto/ui.js');
const { canEquipItem } = await import('../../../../proto_utils/utils.js');

// tools/ sits at ui/core/components/individual_sim_ui/upgrades/tools -- six up.
const FORK_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function readForkCommit(): string {
	return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: FORK_ROOT, encoding: 'utf8' }).trim();
}

// PlayerSpecs mixes spec classes with helper functions. The specs carry specID
// and canDualWield as static properties -- the two fields canEquipItem reads --
// so testing for them separates specs from helpers without naming any spec here.
function isPlayerSpec(value: unknown): boolean {
	const v = value as { specID?: unknown; canDualWield?: unknown } | null;
	return v != null && typeof v.specID === 'number' && typeof v.canDualWield === 'boolean';
}

/**
 * JSON with each spec's id array on ONE line.
 *
 * `JSON.stringify(payload, null, 2)` puts every id on its own line, which for
 * ~79k ids is a megabyte of file and dominates the diff of any commit that
 * touches it. Per-id diff granularity buys nothing here: when this file
 * disagrees with the fork, check_equip_eligibility.py names the exact ids that
 * moved, so a line-per-id would only duplicate the gate's own error output.
 */
function serialize(payload: { _comment: string; generatedFrom: Record<string, string>; itemCount: number; specs: Record<string, number[]> }): string {
	const lines = [
		'{',
		`  ${JSON.stringify('_comment')}: ${JSON.stringify(payload._comment)},`,
		`  ${JSON.stringify('generatedFrom')}: ${JSON.stringify(payload.generatedFrom, null, 4).split('\n').join('\n  ')},`,
		`  ${JSON.stringify('itemCount')}: ${payload.itemCount},`,
		`  ${JSON.stringify('specs')}: {`,
	];
	const names = Object.keys(payload.specs);
	names.forEach((name, i) => {
		const comma = i === names.length - 1 ? '' : ',';
		lines.push(`    ${JSON.stringify(name)}: [${payload.specs[name].join(',')}]${comma}`);
	});
	lines.push('  }', '}', '');
	return lines.join('\n');
}

async function main(): Promise<void> {
	const dbPath = resolvePath(FORK_ROOT, 'assets/database/db.json');
	const raw = JSON.parse(readFileSync(dbPath, 'utf8'));
	const db = UIDatabase.fromJson(raw, { ignoreUnknownFields: true });

	const entries = (Object.entries(PlayerSpecs) as [string, unknown][])
		.filter(([, value]) => isPlayerSpec(value))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

	// A change to the PlayerSpecs enum would otherwise yield an empty-but-green
	// export, which the outer checker would then happily diff against itself.
	if (entries.length === 0) throw new Error('no PlayerSpecs entries matched the spec shape -- has PlayerSpecs changed?');
	if (db.items.length === 0) throw new Error('db.json parsed to zero items');

	const specNames = entries.map(([name]) => name);
	const specs: Record<string, number[]> = {};
	for (const [name, value] of entries) {
		const spec = value as Parameters<typeof canEquipItem>[1];
		const ids: number[] = [];
		for (const item of db.items) {
			// slot undefined: "equippable in at least one slot", which is the
			// question pool membership asks. Slot-specific legality (off-hand
			// rules) is the consumer's business, not the pool's.
			if (canEquipItem(item, spec, undefined)) ids.push(item.id);
		}
		ids.sort((a, b) => a - b);
		specs[name] = ids;
	}

	const payload = {
		_comment:
			'GENERATED -- do not hand-edit. Per-spec equip eligibility computed by the ' +
			"fork's own canEquipItem over its own db.json. Regenerate via the fork " +
			'exporter at ui/core/components/individual_sim_ui/upgrades/tools/; ' +
			'scripts/check_equip_eligibility.py re-runs it and diffs on every pnpm verify.',
		generatedFrom: {
			repo: 'dangreenberggit/tbc-new',
			commit: readForkCommit(),
			source: 'ui/core/proto_utils/utils.ts canEquipItem over assets/database/db.json',
		},
		itemCount: db.items.length,
		specs,
	};

	const outPath = process.argv[2];
	if (!outPath) throw new Error('usage: export_equip_eligibility.mts <output-json-path>');
	writeFileSync(outPath, serialize(payload), { encoding: 'utf8' });

	const counts = specNames.map(n => `${n}=${specs[n].length}`).join(' ');
	process.stderr.write(`equip eligibility: ${specNames.length} specs, ${db.items.length} items\n${counts}\n`);
}

await main();
