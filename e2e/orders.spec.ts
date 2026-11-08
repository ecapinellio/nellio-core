import { test, expect, type Page } from "@playwright/test";
import { authFile, seed } from "./seed";

test.use({ storageState: authFile("operator") });

/** Picks an existing result in EntitySearch — never the "Agregar … como nuevo" quick-add. */
async function pick(page: Page, name: string)
{
	await page.getByRole("button", { name }).filter({ hasNotText: "Agregar" }).click();
}

test("el operador captura un pedido y aparece en el tablero", async ({ page }) =>
{
	const { productName } = seed();
	// Cliente nuevo por corrida: con uno compartido, otro pedido pendiente de
	// hoy abre el diálogo de duplicado (correcto, pero no es este flujo).
	const customerName = crypto.randomUUID(); // sin prefijo común: la búsqueda es por similitud (pg_trgm)

	await page.goto("/orders/capture");
	await page.getByPlaceholder("Buscar cliente, teléfono o NIT...").fill(customerName);
	await page.getByRole("button", { name: `Agregar “${customerName}” como nuevo cliente` }).click();
	await expect(page.getByText(customerName).first()).toBeVisible();
	await page.getByPlaceholder("Buscar o agregar producto...").fill(productName);
	await pick(page, productName);
	await page.getByPlaceholder("hola! necesito 12 bidones de...").fill("necesito 1 galón");
	await page.getByRole("button", { name: "Guardar pedido" }).click();

	const saved = page.getByText(/Pedido guardado \(\w{8}\)/);
	await expect(saved).toBeVisible();
	const ref = (await saved.textContent())!.match(/\((\w{8})\)/)![1];

	// El tablero (escritorio) muestra el pedido recién capturado por su referencia corta.
	await page.goto("/orders");
	await expect(page.getByText(ref).filter({ visible: true })).toBeVisible();
});
