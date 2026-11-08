import { defineConfig } from "vitest/config";

// Testing pyramid (ADR-016):
//   unit         tests/unit/**        pure logic, no network — runs without Docker
//   integration  tests/integration/** real Postgres/Auth/Realtime of the local Supabase stack
//   e2e          e2e/**               Playwright against `next dev` (playwright.config.ts)
export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},
	test: {
		setupFiles: ["./tests/setup.ts"],
		projects: [
			{
				extends: true,
				test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
			},
			{
				extends: true,
				// Each file gets its own tenant (setupTenant), so files run as
				// separate workers without shared-state races.
				test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 15_000 },
			},
		],
		coverage: {
			provider: "v8",
			include: ["lib/**/*.ts", "hooks/**/*.ts", "app/api/**/*.ts"],
			exclude: ["lib/supabase/database.types.ts"],
			reporter: ["text-summary", "html", "json-summary"],
			// Ratchet: set just under the measured baseline. Raise it as coverage
			// grows; never lower it to make a PR pass.
			// Baseline 2026-11-08: ~77% lines; varies ±0.5 between runs (timing-dependent paths).
			thresholds: { lines: 76, functions: 76, branches: 74, statements: 76 },
		},
	},
});
