import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// @cloudflare/vitest-plugin supersedes @cloudflare/vitest-pool-workers: the pool
// and `poolOptions.workers` are replaced by this `cloudflareTest()` plugin.
// Pointing it at wrangler.jsonc still gives the tests the Worker's own bindings.
export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
