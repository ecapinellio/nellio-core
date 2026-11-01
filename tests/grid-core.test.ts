import { describe, expect, it } from "vitest";
import {
	blocksSave,
	fillFromPaste,
	isHeaderLine,
	matchesSearch,
	findDuplicates,
	isProblemIssue,
	normalizeName,
	withTrailingRow,
	type BaseRow,
	type GridModel,
} from "@/lib/grid/core";

// A minimal non-product row, to prove the core doesn't assume products.
interface ContactRow extends BaseRow
{
	name: string;
	phone: string;
	original: { name: string } | null;
}

const contactModel: GridModel<ContactRow, "name" | "phone"> = {
	columns: ["name", "phone"],
	emptyRow: (key) => ({ key, id: null, active: true, updatedAt: null, name: "", phone: "", original: null }),
	isBlank: (r) => r.id === null && r.name === "" && r.phone === "",
	isDirty: (r) => r.original === null ? !(r.name === "" && r.phone === "") : r.name !== r.original.name,
	applyPasted: (r, col, text) => ({ ...r, [col]: text.trim() }),
	nameOf: (r) => r.name,
	originalNameOf: (r) => r.original?.name ?? null,
};

const saved = (name: string): ContactRow => ({ key: name, id: name, active: true, updatedAt: "t", name, phone: "", original: { name } });
let n = 0;
const newKey = () => `k${++n}`;

describe("generic grid core", () =>
{
	it("fills any row shape from a block paste, right then down", () =>
	{
		const result = fillFromPaste(contactModel, [contactModel.emptyRow("a")], 0, "name", "Ana\t2222-3333\textra\nBeto\t7777-8888", newKey)!;
		expect(result.rows.map((r) => [r.name, r.phone])).toEqual([["Ana", "2222-3333"], ["Beto", "7777-8888"]]);
		expect(result.extraColumns).toBe(1);
	});

	it("skips a pasted header row, but never a real row", () =>
	{
		const labels = ["Nombre", "Teléfono", "Cliente"];
		const result = fillFromPaste(contactModel, [contactModel.emptyRow("a")], 0, "name", "CLIENTE\tTelefono\nAna\t2222-3333\n", newKey, labels)!;
		expect(result.skippedHeader).toBe(true);
		expect(result.rows.map((r) => r.name)).toEqual(["Ana"]);
		expect(result.filled).toBe(1);
		// Has a digit, or matches no label: a customer, not a header.
		expect(isHeaderLine("Nombre\t2222-3333", labels)).toBe(false);
		expect(isHeaderLine("Ferretería López\tSoyapango", labels)).toBe(false);
		// Without labels nothing is ever skipped.
		expect(fillFromPaste(contactModel, [contactModel.emptyRow("a")], 0, "name", "Nombre\nAna", newKey)!.skippedHeader).toBe(false);
	});

	it("searches by name, or by phone/NIT digits when the model provides them", () =>
	{
		const model = { ...contactModel, searchDigitsOf: (r: ContactRow) => r.phone };
		const ana = { ...saved("Ana López"), phone: "2222-3333" };
		expect(matchesSearch(model, ana, "lopez")).toBe(true);
		expect(matchesSearch(model, ana, "22223333")).toBe(true);
		expect(matchesSearch(model, ana, "2222-33")).toBe(true);
		expect(matchesSearch(model, ana, "999")).toBe(false);
		expect(matchesSearch(contactModel, ana, "2222")).toBe(false);
	});

	it("flags duplicates by the model's name, ignoring case, accents and spaces", () =>
	{
		const rows = [saved("Ferretería López"), { ...contactModel.emptyRow("n1"), name: "FERRETERIA LÓPEZ " }];
		expect(findDuplicates(contactModel, rows)).toEqual(new Map([["n1", "Ya existe"]]));
		expect(normalizeName("Ferretería  López")).toBe("ferreterialopez");
	});

	it("keeps exactly one trailing blank row", () =>
	{
		const once = withTrailingRow(contactModel, [saved("Ana")], newKey);
		expect(once).toHaveLength(2);
		expect(withTrailingRow(contactModel, once, newKey)).toBe(once);
	});

	describe("severities (customers design D4)", () =>
	{
		const warning = { kind: "warning" as const, message: "Mismo NIT que X" };
		const error = { kind: "error" as const, message: "NIT o DUI inválido" };
		const missing = { kind: "missing" as const };

		it("a warning is never a problem and never blocks saving", () =>
		{
			expect(isProblemIssue(warning, false)).toBe(false);
			expect(isProblemIssue(warning, true)).toBe(false);
			expect(blocksSave({ tax_id: warning, phone: warning }, false)).toBe(false);
		});

		it("errors always count; missing counts once a save was attempted, and blocks saving", () =>
		{
			expect(isProblemIssue(error, false)).toBe(true);
			expect(isProblemIssue(missing, false)).toBe(false);
			expect(isProblemIssue(missing, true)).toBe(true);
			expect(blocksSave({ tax_id: error }, false)).toBe(true);
			expect(blocksSave({ name: missing }, false)).toBe(true);
			expect(blocksSave({}, true)).toBe(true);
		});
	});
});
