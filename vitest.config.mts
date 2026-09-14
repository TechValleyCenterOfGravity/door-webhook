import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// vitest-pool-workers 0.22 replaced the `/config` subpath and `poolOptions.workers`
// with a `cloudflareTest()` plugin. Pointing it at wrangler.jsonc still gives the
// tests the Worker's own config and bindings.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
