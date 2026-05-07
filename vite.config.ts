import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { finnWsDevPlugin } from './src/lib/server/ws/dev-plugin';

// Load secrets from the data volume *before* SvelteKit / our plugin spin up,
// so the connector reads them from process.env. See docs/decisions/0001
// for why secrets live outside the repo.
const SECRETS_PATH = path.join(os.homedir(), 'finn-data', 'secrets', '.env');
dotenv.config({ path: SECRETS_PATH, quiet: true });

export default defineConfig({
	plugins: [sveltekit(), finnWsDevPlugin()]
});
