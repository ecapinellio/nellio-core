import { describe, expect, it } from "vitest";
import { parsePrice, priceErrorMessage } from "@/lib/products/parse";
import { parseUnit } from "@/lib/products/units";
import {
	emptyRow,
	fillFromPaste,
	findDuplicates,
	isDirty,
	normalizeProductName,
	rowFromProduct,
	rowIssues,
	toSavePayload,
	type GridRow,
} from "@/lib/products/grid";

function keys()
{
	let n = 0;
	return () => `new-${++n}`;
}

const saved = (name: string, price: number | null = 12.5, unit: string | null = "gal"): GridRow =>
	rowFromProduct({ id: `id-${name}`, name, price_per_unit: price, unit, active: true, updated_at: "2026-10-28 20:00:00.123456+00" });

describe("parsePrice() — El Salvador format, never guesses (D6)", () =>
{
	it.each([
		["12.5", 12.5],
		["12.50", 12.5],
		["$1,250.00", 1250],
		["$ 1,250", 1250],
		["1,250,000.5", 1250000.5],
		["1250", 1250],
		[".75", 0.75],
		["  8.00 ", 8],
	])("%s → %s", (text, value) =>
	{
		expect(parsePrice(text)).toEqual({ ok: true, value });
	});

	it.each([
		["12,50", [12.5]],
		["12,5", [12.5]],
		["1.250", [1.25, 1250]],
		["12.555", [12555]],
		["1.290", [1.29, 1290]],
		["1.250,00", [1250]],
		["1.250.000", [1250000]],
	])("%s is ambiguous, not converted", (text, suggestions) =>
	{
		expect(parsePrice(text)).toEqual({ ok: false, reason: "ambiguous", suggestions });
	});

	it("rejects blanks, garbage, zero, negatives and >2 decimals", () =>
	{
		expect(parsePrice("")).toEqual({ ok: false, reason: "empty" });
		expect(parsePrice("  ")).toEqual({ ok: false, reason: "empty" });
		expect(parsePrice("abc")).toEqual({ ok: false, reason: "invalid" });
		expect(parsePrice("12.5.3")).toEqual({ ok: false, reason: "invalid" });
		expect(parsePrice("0")).toEqual({ ok: false, reason: "nonpositive" });
		expect(parsePrice("-3")).toEqual({ ok: false, reason: "nonpositive" });
		expect(parsePrice("12.5555")).toEqual({ ok: false, reason: "decimals" });
	});

	it("explains each error in Spanish", () =>
	{
		const ambiguous = parsePrice("12,50");
		const twoWays = parsePrice("1.250");
		expect(!ambiguous.ok && priceErrorMessage(ambiguous)).toBe("¿Quisiste decir 12.50?");
		expect(!twoWays.ok && priceErrorMessage(twoWays)).toBe("¿Quisiste decir 1.25 o 1250.00?");
	});
});

describe("parseUnit() — fixed synonym table", () =>
{
	it.each([
		["Galón", "gal"], ["galones", "gal"], ["GAL", "gal"],
		["Litro", "l"], ["Lts.", "l"], ["L", "l"],
		["Tonelada", "ton"], ["tn", "ton"],
		["kilos", "kg"], ["Kg.", "kg"],
		["Libras", "lb"],
		["Unidad", "each"], ["c/u", "each"], ["pza", "each"],
	])("%s → %s", (text, unit) =>
	{
		expect(parseUnit(text)).toBe(unit);
	});

	it("returns null for units we don't have", () =>
	{
		expect(parseUnit("saco")).toBeNull();
		expect(parseUnit("cubeta")).toBeNull();
		expect(parseUnit("")).toBeNull();
	});
});

describe("normalizeProductName() — same spec as the SQL helper", () =>
{
	// Mirrored in tests/save-products.test.ts against normalize_product_name().
	it.each([
		["Cloro 5%", "cloro5%"],
		["CLORO 5 %", "cloro5%"],
		["  Ácido  Muriático ", "acidomuriatico"],
		["Soda cáustica", "sodacaustica"],
		["Niño", "nino"],
	])("%s → %s", (name, norm) =>
	{
		expect(normalizeProductName(name)).toBe(norm);
	});
});

describe("fillFromPaste()", () =>
{
	it("single value on one line → null (normal input paste)", () =>
	{
		expect(fillFromPaste([emptyRow("a")], 0, "name", "Cloro", keys())).toBeNull();
		expect(fillFromPaste([emptyRow("a")], 0, "name", "Cloro\n", keys())).toBeNull();
	});

	it("a column fills down, creating rows; CRLF and trailing blank lines handled", () =>
	{
		const result = fillFromPaste([emptyRow("a")], 0, "name", "Cloro 5%\r\nSoda\r\nÁcido\r\n\r\n", keys())!;
		expect(result.filled).toBe(3);
		expect(result.rows.map((r) => r.name)).toEqual(["Cloro 5%", "Soda", "Ácido"]);
		expect(result.extraColumns).toBe(0);
	});

	it("a second column pasted later lines up with the same rows", () =>
	{
		const names = fillFromPaste([emptyRow("a")], 0, "name", "Cloro\nSoda", keys())!;
		const prices = fillFromPaste(names.rows, 0, "price", "12.50\n$1,250", keys())!;
		expect(prices.rows.map((r) => [r.name, r.price])).toEqual([["Cloro", "12.50"], ["Soda", "$1,250"]]);
	});

	it("a block fills right (D7) and counts dropped extra columns", () =>
	{
		const text = "Cloro\t12.50\tGalón\tA-01\nSaco cal\t8\tsaco\tA-02";
		const result = fillFromPaste([emptyRow("a")], 0, "name", text, keys())!;
		expect(result.extraColumns).toBe(1);
		expect(result.rows[0]).toMatchObject({ name: "Cloro", price: "12.50", unit: "gal", unitRaw: null });
		expect(result.rows[1]).toMatchObject({ name: "Saco cal", unit: "", unitRaw: "saco" });
	});

	it("pasting into a middle row starts there; a block from Precio drops the extra", () =>
	{
		const rows = [saved("A"), saved("B"), saved("C")];
		const result = fillFromPaste(rows, 1, "price", "9\tkg\textra\n10\tlb", keys())!;
		expect(result.rows.map((r) => [r.price, r.unit])).toEqual([["12.50", "gal"], ["9", "kg"], ["10", "lb"]]);
		expect(result.extraColumns).toBe(1);
	});
});

describe("rowIssues() — 'falta' vs real errors (design D6)", () =>
{
	it("blank new rows have no issues", () =>
	{
		expect(rowIssues(emptyRow("a"))).toEqual({});
	});

	it("a pasted name alone shows missing price/unit, not errors", () =>
	{
		expect(rowIssues({ ...emptyRow("a"), name: "Cloro" })).toEqual({ price: { kind: "missing" }, unit: { kind: "missing" } });
	});

	it("real problems are errors with a reason", () =>
	{
		const row = { ...emptyRow("a"), name: "x".repeat(201), price: "12,50", unitRaw: "saco" };
		expect(rowIssues(row)).toEqual({
			name: { kind: "error", message: "Máximo 200 caracteres" },
			price: { kind: "error", message: "¿Quisiste decir 12.50?" },
			unit: { kind: "error", message: "‘saco’ no reconocida" },
		});
	});

	it("a quick-added product without price can be renamed or deactivated (outside voice #6)", () =>
	{
		const quick = saved("Desengrasante", null, null);
		expect(rowIssues({ ...quick, name: "Desengrasante industrial", active: false })).toEqual({});
		// but clearing a price that existed is not allowed
		expect(rowIssues({ ...saved("Cloro"), price: "" })).toEqual({ price: { kind: "missing" } });
	});
});

describe("findDuplicates()", () =>
{
	it("flags the new row as 'Ya existe' when it collides with a saved one", () =>
	{
		const rows = [saved("Cloro 5%"), { ...emptyRow("n1"), name: "CLORO 5 %" }];
		expect(findDuplicates(rows)).toEqual(new Map([["n1", "Ya existe"]]));
	});

	it("flags both new rows as 'Repetido' when they collide with each other", () =>
	{
		const rows = [{ ...emptyRow("n1"), name: "Soda" }, { ...emptyRow("n2"), name: "sóda" }];
		expect(findDuplicates(rows)).toEqual(new Map([["n1", "Repetido"], ["n2", "Repetido"]]));
	});

	it("a rename into an existing name is flagged on the renamed row only", () =>
	{
		const rows = [saved("Cloro"), { ...saved("Soda"), name: "cloro" }];
		expect(findDuplicates(rows)).toEqual(new Map([["id-Soda", "Ya existe"]]));
	});
});

describe("isDirty() / toSavePayload()", () =>
{
	it("sends only new and changed rows, with parsed values and the exact updated_at", () =>
	{
		const unchanged = saved("Cloro");
		const edited = { ...saved("Soda"), price: "$1,300.00" };
		const added = { ...emptyRow("n1"), name: "Ácido", price: "4", unit: "l" as const };
		const blank = emptyRow("n2");

		expect([unchanged, edited, added, blank].map(isDirty)).toEqual([false, true, true, false]);
		expect(toSavePayload([unchanged, edited, added, blank])).toEqual([
			{ id: "id-Soda", name: "Soda", price_per_unit: 1300, unit: "gal", active: true, updated_at: "2026-10-28 20:00:00.123456+00" },
			{ id: null, name: "Ácido", price_per_unit: 4, unit: "l", active: true, updated_at: null },
		]);
	});
});
