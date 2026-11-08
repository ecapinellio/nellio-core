import { test, expect } from "@playwright/test";
import { authFile, seed, TEST_PASSWORD } from "./seed";

test.describe("sin sesión", () =>
{
	test("una ruta privada manda a /login", async ({ page }) =>
	{
		await page.goto("/orders");
		await expect(page).toHaveURL(/\/login/);
	});

	test("contraseña incorrecta muestra el error y no entra", async ({ page }) =>
	{
		await page.goto("/login");
		await page.getByLabel("Correo").fill(seed().emails.operator);
		await page.getByLabel("Contraseña").fill(`${TEST_PASSWORD}x`);
		await page.getByRole("button", { name: "Entrar" }).click();
		await expect(page.getByText("Correo o contraseña incorrectos.")).toBeVisible();
		await expect(page).toHaveURL(/\/login/);
	});
});

test.describe("acceso por rol (lib/rbac.ts)", () =>
{
	test.describe("driver", () =>
	{
		test.use({ storageState: authFile("driver") });

		test("no entra a /orders", async ({ page }) =>
		{
			await page.goto("/orders");
			await expect(page).toHaveURL(/\/deliveries/);
		});
	});

	test.describe("operator", () =>
	{
		test.use({ storageState: authFile("operator") });

		test("no entra a la administración", async ({ page }) =>
		{
			await page.goto("/admin/users");
			await expect(page).not.toHaveURL(/\/admin/);
			await expect(page.getByRole("link", { name: "Usuarios" })).toHaveCount(0);
		});
	});

	test.describe("admin", () =>
	{
		test.use({ storageState: authFile("admin") });

		test("ve a su equipo en /admin/users", async ({ page }) =>
		{
			await page.goto("/admin/users");
			await expect(page.getByRole("cell", { name: "Test driver" })).toBeVisible();
		});
	});
});

test.describe("cerrar sesión", () =>
{
	// Usuario propio y login de verdad: cerrar sesión revoca todas las
	// sesiones del usuario y rompería los tests que corren en paralelo.
	test("vuelve a /login y la sesión deja de servir", async ({ page }) =>
	{
		await page.goto("/login");
		await page.getByLabel("Correo").fill(seed().logoutEmail);
		await page.getByLabel("Contraseña").fill(TEST_PASSWORD);
		await page.getByRole("button", { name: "Entrar" }).click();
		await expect(page).toHaveURL(/\/orders\/capture/);

		await page.getByRole("button", { name: "Cerrar sesión" }).click();
		await expect(page).toHaveURL(/\/login/);
		await page.goto("/orders");
		await expect(page).toHaveURL(/\/login/);
	});
});
