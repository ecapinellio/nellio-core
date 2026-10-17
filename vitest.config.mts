import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		setupFiles: ["./tests/setup.ts"],
		// Integration tests against the local Supabase stack (T7, Decision 1) —
		// each file gets its own tenant (Decision 2), so files are safe to run
		// as separate workers without shared-state races.
		testTimeout: 15_000,
	},
});
