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
	plugins: [sveltekit(), finnWsDevPlugin()],
	build: {
		// Mermaid is lazy-loaded (dynamic import in mermaid.ts) but Vite
		// bundles it into a shared chunk that tips the 500 kB default threshold.
		// The chunk is only 137 kB gzipped and loads lazily — no real concern.
		chunkSizeWarningLimit: 700
	}
});
