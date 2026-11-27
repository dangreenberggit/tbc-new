/**
 * The `@sim/proto/database` module for engine tests that rank against a fake sim: the real
 * `Database` class over `assets/database/db.json`, so `getItem`, `getGem` and the per-request
 * database resolver read real rows. Use it as
 *
 *     vi.mock('@sim/proto/database', importOriginal => import('../testing/database_mock').then(m => m.withTestDatabase(importOriginal)));
 *
 * This module must not import `@sim/proto/database` itself: the mock would wait on itself.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UIDatabase } from '@generated/proto/ui';

type DatabaseModule = typeof import('@sim/proto/database');

const DB_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../assets/database/db.json');

export async function withTestDatabase(importOriginal: <T>() => Promise<T>): Promise<DatabaseModule> {
	const actual = await importOriginal<DatabaseModule>();
	const proto = UIDatabase.fromJson(JSON.parse(readFileSync(DB_PATH, 'utf8')), { ignoreUnknownFields: true });
	const db = new (actual.Database as unknown as new (proto: UIDatabase) => unknown)(proto);
	// Only `getSync` changes: the class's other statics stay, since the resolver calls `mergeSimDatabases`.
	return { ...actual, Database: Object.assign(Object.create(actual.Database), { getSync: () => db }) };
}
