import { test as setup, expect } from "@playwright/test";
import { authFile, seed, TEST_PASSWORD } from "./seed";

// Logs each role in through the real /login form once; specs reuse the
// session via storageState instead of logging in on every test.
for (const role of ["admin", "operator", "driver"] as const)
{
	setup(`login as ${role}`, async ({ page }) =>
	{
		await page.goto("/login");
		await page.getByLabel("Correo").fill(seed().emails[role]);
		await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
		await page.getByRole("button", { name: "Entrar" }).click();
		await expect(page).toHaveURL(role === "driver" ? /\/deliveries/ : /\/orders\/capture/);
		await page.context().storageState({ path: authFile(role) });
	});
}
