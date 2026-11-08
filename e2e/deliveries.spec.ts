import { test, expect } from "@playwright/test";
import { authFile, seed } from "./seed";

test.describe("chofer", () =>
{
	test.use({ storageState: authFile("driver") });

	test("ve el pedido que le asignaron", async ({ page }) =>
	{
		await page.goto("/deliveries");
		await expect(page.getByRole("heading", { name: "Mis pedidos" })).toBeVisible();
		await expect(page.getByText(seed().customerName).first()).toBeVisible();
	});
});

test.describe("seguimiento público (ADR-013)", () =>
{
	test("el cliente ve su pedido sin iniciar sesión", async ({ page }) =>
	{
		await page.goto(`/t/${seed().trackingToken}`);
		await expect(page.getByRole("heading", { name: /Pedido #/ })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Historial" })).toBeVisible();
	});

	test("un token inventado no muestra nada", async ({ page }) =>
	{
		await page.goto(`/t/${"0".repeat(64)}`);
		await expect(page.getByRole("heading", { name: /Pedido #/ })).toHaveCount(0);
	});
});
