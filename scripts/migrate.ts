#!/usr/bin/env tsx
/**
 * Apply pending Drizzle migrations to the local DB.
 *
 * Usage:
 *   npm run db:migrate
 *
 * The DB file lives at ~/finn-data/finn.db (or FINN_DB_PATH override).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

const file = process.env.FINN_DB_PATH ?? path.join(os.homedir(), 'finn-data', 'finn.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const sqlite = new Database(file);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

const db = drizzle(sqlite);

console.log(`finn: applying migrations to ${file}`);
migrate(db, { migrationsFolder: './drizzle' });
console.log('finn: migrations done');

sqlite.close();
