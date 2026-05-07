import { defineConfig } from 'drizzle-kit';
import os from 'node:os';
import path from 'node:path';

/**
 * drizzle-kit configuration.
 *
 * Migrations live under `drizzle/` in the repo (committed). The DB file
 * itself lives in the data volume (~/finn-data/finn.db) and is not part
 * of the repo.
 *
 * Generate a migration after changing the schema:
 *   npm run db:generate
 *
 * Apply pending migrations to the local DB:
 *   npm run db:migrate
 */
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: process.env.FINN_DB_PATH ?? path.join(os.homedir(), 'finn-data', 'finn.db')
	},
	verbose: true,
	strict: true
});
