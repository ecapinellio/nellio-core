import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		// Only the app's suite: worktrees under .claude/ and vendored skills
		// under .agents/ carry their own tests.
		include: ["tests/**/*.test.ts"],
		setupFiles: ["./tests/setup.ts"],
		// Integration tests against the local Supabase stack (T7, Decision 1) —
		// each file gets its own tenant (Decision 2), so files are safe to run
		// as separate workers without shared-state races.
		testTimeout: 15_000,
	},
});
