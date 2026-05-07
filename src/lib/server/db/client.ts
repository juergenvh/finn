/**
 * SQLite + Drizzle client.
 *
 * The database file lives in the data volume (~/finn-data/finn.db),
 * never inside the repo. See README §"Layout on disk".
 *
 * Process-singleton: opening better-sqlite3 multiple times against the
 * same file is fine in WAL mode, but the application-side cache and
 * prepared statements are per-instance. We keep a single instance here.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

/** Resolve the on-disk path. Override with FINN_DB_PATH for tests. */
export function dbPath(): string {
	return process.env.FINN_DB_PATH ?? path.join(os.homedir(), 'finn-data', 'finn.db');
}

let cached: { sqlite: Database.Database; db: DB } | null = null;

export function getDb(): DB {
	if (cached) return cached.db;

	const file = dbPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });

	const sqlite = new Database(file);
	// Standard SQLite hardening for concurrent readers + foreign keys.
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	sqlite.pragma('synchronous = NORMAL');

	const db = drizzle(sqlite, { schema });
	cached = { sqlite, db };
	return db;
}

/** Close the underlying connection. Test helper. */
export function closeDb(): void {
	if (cached) {
		cached.sqlite.close();
		cached = null;
	}
}
