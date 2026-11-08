import { defineConfig, devices } from "@playwright/test";
import "./tests/setup"; // loads .env.local (CI sets the vars directly)

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
	testDir: "e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// `next dev` compiles each route on its first visit; CI runners are slow at it.
	expect: { timeout: process.env.CI ? 15_000 : 5_000 },
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
	globalSetup: "./e2e/global-setup.ts",
	use: {
		baseURL,
		locale: "es-SV",
		timezoneId: "America/El_Salvador",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "setup", testMatch: /auth\.setup\.ts/ },
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			dependencies: ["setup"],
		},
	],
	// `next dev`, not `next start`: outside development BotID calls Vercel's API
	// and login fails (ADR-011). Production behaviour is covered by the build job.
	webServer: {
		command: `pnpm exec next dev --port ${PORT}`,
		url: `${baseURL}/login`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
	},
});
