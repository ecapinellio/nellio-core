import { describe, expect, it } from "vitest";
import { isValidActivityCode, isValidEmail, normalizeNrc, normalizeTaxId, phoneLooksIncomplete } from "@/lib/customers/parse";
import {
	applyPastedCustomerCell,
	buildCustomerContext,
	customerIssues,
	emptyCustomerRow,
	fiscalFilled,
	isDirtyCustomer,
	isNameOnly,
	rowFromCustomer,
	sharedTaxIdNote,
	toCustomerPayload,
	type CustomerRecord,
	type CustomerRow,
} from "@/lib/customers/grid";

const record = (over: Partial<CustomerRecord> = {}): CustomerRecord => ({
	id: `id-${over.name ?? "x"}`, name: "Super Selectos Escalón", phone: "2222-3333", address: "Paseo Escalón", tax_id: "0614-010190-101-3",
	legal_name: null, nrc: null, cod_actividad: null, desc_actividad: null, email: null, active: true, updated_at: "2026-11-01 10:00:00.123456+00", ...over,
});

const issues = (row: CustomerRow, rows: CustomerRow[] = [row]) => customerIssues(row, buildCustomerContext(rows));

describe("normalizeTaxId() — NIT or DUI (D6), Excel's lost zero (outside voice #3)", () =>
{
	it.each([
		["0614-010190-101-3", "0614-010190-101-3", false],
		["06140101901013", "0614-010190-101-3", false],
		["6140101901013", "0614-010190-101-3", true],
		["01234567-8", "01234567-8", false],
		["012345678", "01234567-8", false],
		["12345678", "01234567-8", true],
	])("%s → %s", (text, value, padded) =>
	{
		expect(normalizeTaxId(text)).toEqual({ value, padded });
	});

	it("rejects anything else", () =>
	{
		expect(normalizeTaxId("N/A")).toBeNull();
		expect(normalizeTaxId("12345")).toBeNull();
		expect(normalizeTaxId("061401019010133")).toBeNull();
		// An 8-digit phone in the NIT column is not a DUI missing its zero.
		expect(normalizeTaxId("2222-3333")).toBeNull();
	});
});

describe("NRC, email, activity code, phone", () =>
{
	it("normalizes NRC and rejects junk", () =>
	{
		expect(normalizeNrc("1234567")).toBe("123456-7");
		expect(normalizeNrc("123456-7")).toBe("123456-7");
		expect(normalizeNrc("12")).toBe("1-2");
		expect(normalizeNrc("1")).toBeNull();
		expect(normalizeNrc("NRC 123")).toBeNull();
	});

	it("checks email and activity code shapes", () =>
	{
		expect(isValidEmail("compras@selectos.com.sv")).toBe(true);
		expect(isValidEmail("compras@selectos")).toBe(false);
		expect(isValidActivityCode("46900")).toBe(true);
		expect(isValidActivityCode("4690")).toBe(false);
	});

	it("phones are free text; under 8 digits is only worth a look (D10)", () =>
	{
		expect(phoneLooksIncomplete("2222-3333 / 7777-8888")).toBe(false);
		expect(phoneLooksIncomplete("2222-3333 ext. 12")).toBe(false);
		expect(phoneLooksIncomplete("N/A")).toBe(true);
		expect(phoneLooksIncomplete("")).toBe(false);
	});
});

describe("customer rows", () =>
{
	it("a pasted NIT is canonicalized and remembers a restored zero; an invalid one is kept as pasted", () =>
	{
		const padded = applyPastedCustomerCell(emptyCustomerRow("a"), "tax_id", "6140101901013");
		expect(padded).toMatchObject({ tax_id: "0614-010190-101-3", taxIdPadded: true });
		const invalid = applyPastedCustomerCell(emptyCustomerRow("a"), "tax_id", "N/A");
		expect(invalid).toMatchObject({ tax_id: "N/A", taxIdPadded: false });
	});

	it("severities: invalid NIT is an error, short phone a warning, panel errors land on 'fiscal'", () =>
	{
		const row = { ...emptyCustomerRow("n1"), name: "Ferretería López", phone: "N/A", tax_id: "123", nrc: "x", email: "nope" };
		expect(issues(row)).toEqual({
			phone: { kind: "warning", message: "¿Teléfono incompleto?" },
			tax_id: { kind: "error", message: "NIT o DUI inválido" },
			fiscal: { kind: "error", message: "NRC inválido" },
		});
	});

	it("same NIT warns only on new or changed rows (D5); saved ones get a quiet note", () =>
	{
		const escalon = rowFromCustomer(record({ name: "Super Selectos Escalón" }));
		const santaAna = { ...emptyCustomerRow("n1"), name: "Super Selectos Santa Ana", tax_id: "0614-010190-101-3" };
		const rows = [escalon, santaAna];
		expect(issues(santaAna, rows).tax_id).toEqual({ kind: "warning", message: "Mismo NIT que Super Selectos Escalón" });
		expect(issues(escalon, rows).tax_id).toBeUndefined();
		expect(sharedTaxIdNote(escalon, buildCustomerContext(rows))).toBe("Comparte NIT con 1 más");
	});

	it("a legacy, badly formatted NIT doesn't block editing other fields (outside voice #10)", () =>
	{
		const legacy = rowFromCustomer(record({ tax_id: "NIT pendiente" }));
		expect(issues({ ...legacy, name: "Nuevo nombre" }).tax_id).toBeUndefined();
		expect(issues({ ...legacy, tax_id: "otro malo" }).tax_id).toEqual({ kind: "error", message: "NIT o DUI inválido" });
	});

	it("counts fiscal data, spots name-only customers, and sends every field in the payload", () =>
	{
		const quick = rowFromCustomer(record({ name: "Quick", phone: null, address: null, tax_id: null }));
		expect(isNameOnly(quick)).toBe(true);
		expect(fiscalFilled({ ...quick, legal_name: "Quick S.A. de C.V.", email: "a@b.co" })).toBe(2);

		const edited = { ...quick, nrc: "1234567", tax_id: "12345678" };
		expect(isDirtyCustomer(edited)).toBe(true);
		expect(toCustomerPayload([edited])).toEqual([{
			id: "id-Quick", name: "Quick", phone: null, address: null, tax_id: "01234567-8", legal_name: null, nrc: "123456-7",
			cod_actividad: null, desc_actividad: null, email: null, active: true, updated_at: "2026-11-01 10:00:00.123456+00",
		}]);
	});
});
