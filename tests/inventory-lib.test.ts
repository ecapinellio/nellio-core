import { describe, expect, it } from "vitest";
import { parseCountPaste, parseQuantity } from "@/lib/inventory/stock";

describe("parseQuantity", () =>
{
	it("accepts SV formats and zero, rejects ambiguous or negative", () =>
	{
		expect(parseQuantity("0")).toBe(0);
		expect(parseQuantity(" 12.5 ")).toBe(12.5);
		expect(parseQuantity("1,250.75")).toBe(1250.75);
		expect(parseQuantity("12,5")).toBeNull();
		expect(parseQuantity("-3")).toBeNull();
		expect(parseQuantity("1.234")).toBeNull();
		expect(parseQuantity("")).toBeNull();
	});
});

describe("parseCountPaste", () =>
{
	const products = [{ id: "a", name: "Cloro 5%" }, { id: "b", name: "Soda Cáustica" }];

	it("matches names like the catalog, skips a header and blank lines, reports bad lines", () =>
	{
		const lines = parseCountPaste("Producto\tCantidad\nCLORO 5 %\t10\n\nsoda caustica\t2,5\nAgua\t3\n", products);
		expect(lines).toEqual([
			{ ok: true, line: 2, productId: "a", name: "Cloro 5%", quantity: 10 },
			{ ok: false, line: 4, text: "soda caustica: 2,5", reason: "Cantidad inválida" },
			{ ok: false, line: 5, text: "Agua", reason: "Producto no encontrado" },
		]);
	});
});
