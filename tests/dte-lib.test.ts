import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildDte, dteProblems, dteTypeFor, type DteOrder } from "@/lib/dte/build";
import { amountInWords } from "@/lib/dte/letters";
import { signDte } from "@/lib/dte/sign";
import { buildInvalidation } from "@/lib/dte/invalidation";
import { DEPARTMENTS, DISTRICTS, MUNICIPALITIES } from "@/lib/dte/places";

// Hacienda's official JSON Schemas (factura.gob.sv, 2026-08-11).
const ajv = new Ajv({ strict: false, allErrors: true, multipleOfPrecision: 8 });
addFormats(ajv);
const schema = (file: string) => ajv.compile(JSON.parse(readFileSync(`tests/dte-schemas/${file}`, "utf8")));
const validateFe = schema("fe-f-v2.json");
const validateCcf = schema("fe-ccf-v4.json");
const validateInvalidation = schema("invalidacion-schema-v3.json");

const tenant: DteOrder["tenant"] = {
	nit: "0614-010190-101-1",
	nrc: "12345-6",
	legal_name: "Ecología Técnica, S.A. de C.V.",
	commercial_name: "ECTEC",
	cod_actividad: "46900",
	desc_actividad: "Venta al por mayor de productos químicos",
	department_code: "06",
	municipality_code: "23",
	district_code: "14",
	address: "Calle El Progreso 123",
	phone: "2222-3333",
	email: "facturas@ectec.com.sv",
	establishment_code: "M001",
	pos_code: "P001",
	prices_include_vat: false,
};

const company: DteOrder["customer"] = {
	name: "Hotel Sol",
	legal_name: "Hoteles del Sol, S.A. de C.V.",
	tax_id: "0614-020290-102-3",
	nrc: "765-4",
	cod_actividad: "55101",
	desc_actividad: "Actividades de alojamiento",
	department_code: "05",
	municipality_code: "27",
	district_code: "08",
	address: "Playa El Tunco",
	phone: "7777-8888",
	email: "compras@hotelsol.com",
};

const consumer: DteOrder["customer"] = {
	name: "Juan Pérez", legal_name: null, tax_id: null, nrc: null, cod_actividad: null, desc_actividad: null,
	department_code: null, municipality_code: null, district_code: null, address: null, phone: null, email: null,
};

const lines: DteOrder["lines"] = [
	{ product: "Cloro 10%", quantity: 3, delivered_quantity: null, price_at_order: 10.01, unit_at_order: "gal" },
	{ product: "Soda cáustica", quantity: 5, delivered_quantity: 2, price_at_order: 7.5, unit_at_order: "kg" },
	{ product: "Rechazado", quantity: 1, delivered_quantity: 0, price_at_order: 3, unit_at_order: null },
];

const id = (dteType: "01" | "03") => ({
	dteType,
	environment: "00" as const,
	controlNumber: `DTE-${dteType}-M001P001-000000000000001`,
	generationCode: "6B3C2A10-4D5E-4F60-8A7B-9C0D1E2F3A4B",
});
const now = new Date("2026-11-07T20:30:15Z");

type Dte = { identificacion: Record<string, unknown>; resumen: Record<string, number>; cuerpoDocumento: Record<string, unknown>[]; receptor: Record<string, unknown> | null };

describe("dteTypeFor", () =>
{
	it("CCF with NRC, Factura without", () =>
	{
		expect(dteTypeFor(company)).toBe("03");
		expect(dteTypeFor(consumer)).toBe("01");
		expect(dteTypeFor({ nrc: "  " })).toBe("01");
	});
});

describe("buildDte", () =>
{
	it("CCF: valid against fe-ccf-v4, prices without VAT, 13% in the summary", () =>
	{
		const order: DteOrder = { tenant, customer: company, lines, payment_method: "cash" };
		expect(dteProblems(order, "03")).toEqual([]);
		const dte = buildDte(order, id("03"), now) as Dte;
		expect(validateCcf(dte), JSON.stringify(validateCcf.errors)).toBe(true);

		expect(dte.cuerpoDocumento).toHaveLength(2); // the 0-delivered line is left out
		expect(dte.cuerpoDocumento[0]).toMatchObject({ precioUni: 10.01, ventaGravada: 30.03, uniMedida: 22, tributos: ["20"] });
		expect(dte.cuerpoDocumento[1]).toMatchObject({ cantidad: 2, ventaGravada: 15, uniMedida: 34 });
		expect(dte.resumen).toMatchObject({ totalGravada: 45.03, montoTotalOperacion: 50.88, totalPagar: 50.88, condicionOperacion: 1 });
		expect(dte.receptor).toMatchObject({ nit: "06140202901023", nrc: "7654", nombre: "Hoteles del Sol, S.A. de C.V." });
		expect(dte.identificacion).toMatchObject({ version: 4, fecEmi: "2026-11-07", horEmi: "14:30:15" });
	});

	it("Factura: valid against fe-f-v2, unit price with VAT and ivaItem", () =>
	{
		const order: DteOrder = { tenant, customer: consumer, lines, payment_method: "credit" };
		expect(dteProblems(order, "01")).toEqual([]);
		const dte = buildDte(order, id("01"), now) as Dte;
		expect(validateFe(dte), JSON.stringify(validateFe.errors)).toBe(true);

		expect(dte.cuerpoDocumento[0].precioUni).toBeCloseTo(11.3113, 8);
		expect(dte.resumen.totalPagar).toBe(50.88);
		expect(dte.resumen.totalIva).toBe(5.85);
		expect(dte.resumen.condicionOperacion).toBe(2);
		expect(dte.receptor).toMatchObject({ tipoDocumento: null, numDocumento: null, nombre: "Juan Pérez" });
	});

	it("prices that include VAT: CCF backs it out, Factura keeps it", () =>
	{
		const vatTenant = { ...tenant, prices_include_vat: true };
		const one = [{ product: "Cloro", quantity: 1, delivered_quantity: null, price_at_order: 11.3, unit_at_order: "gal" }];
		const ccf = buildDte({ tenant: vatTenant, customer: company, lines: one, payment_method: "transfer" }, id("03"), now) as Dte;
		expect(ccf.resumen).toMatchObject({ totalGravada: 10, totalPagar: 11.3 });
		const fe = buildDte({ tenant: vatTenant, customer: consumer, lines: one, payment_method: null }, id("01"), now) as Dte;
		expect(validateFe(fe), JSON.stringify(validateFe.errors)).toBe(true);
		expect(fe.resumen).toMatchObject({ totalGravada: 11.3, totalIva: 1.3, totalPagar: 11.3, condicionOperacion: 3 });
	});

	it("Factura to a customer with DUI: tipoDocumento 13", () =>
	{
		const dte = buildDte({ tenant, customer: { ...consumer, tax_id: "04567890-1" }, lines, payment_method: "cash" }, id("01"), now) as Dte;
		expect(validateFe(dte), JSON.stringify(validateFe.errors)).toBe(true);
		expect(dte.receptor).toMatchObject({ tipoDocumento: "13", numDocumento: "04567890-1" });
	});

	it("reports what is missing, in Spanish", () =>
	{
		const problems = dteProblems({
			tenant: { ...tenant, district_code: null, phone: null },
			customer: { ...company, tax_id: null, address: null },
			lines: [{ product: "Sin precio", quantity: 1, delivered_quantity: null, price_at_order: null, unit_at_order: null }],
			payment_method: null,
		}, "03");
		expect(problems).toEqual([
			"A los datos de la empresa les falta: dirección, teléfono.",
			"Para el crédito fiscal, al cliente \"Hotel Sol\" le falta: NIT, dirección completa (departamento, municipio, distrito y dirección).",
			"\"Sin precio\" no tiene precio.",
		]);
		expect(dteProblems({ tenant, customer: consumer, lines: [lines[2]], payment_method: null }, "01"))
			.toEqual(["El pedido no tiene productos entregados."]);
	});
});

describe("amountInWords", () =>
{
	it.each([
		[0.5, "CERO 50/100 DÓLARES"],
		[1, "UNO 00/100 DÓLARES"],
		[100, "CIEN 00/100 DÓLARES"],
		[120.5, "CIENTO VEINTE 50/100 DÓLARES"],
		[1021.07, "MIL VEINTIUNO 07/100 DÓLARES"],
		[21000, "VEINTIÚN MIL 00/100 DÓLARES"],
		[101000, "CIENTO UN MIL 00/100 DÓLARES"],
		[2_345_678.99, "DOS MILLONES TRESCIENTOS CUARENTA Y CINCO MIL SEISCIENTOS SETENTA Y OCHO 99/100 DÓLARES"],
	])("%s", (amount, words) =>
	{
		expect(amountInWords(amount)).toBe(words);
	});
});

describe("signDte", () =>
{
	// A certificate in Hacienda's XML shape, with a fresh key.
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
	const password = "Clave-Privada-1";
	const certificate = `<CertificadoMH><nit>06140101901011</nit><privateKey><keyType>PRIVATE</keyType>` +
		`<algorithm>RSA</algorithm><encodied>${der}</encodied><format>PKCS#8</format>` +
		`<clave>${createHash("sha512").update(password).digest("hex")}</clave></privateKey></CertificadoMH>`;

	it("produces a compact RS512 JWS of the document", () =>
	{
		const doc = { hello: "mundo" };
		const [header, payload, signature] = signDte(doc, certificate, password).split(".");
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS512" });
		expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual(doc);
		const ok = verify("sha512", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"));
		expect(ok).toBe(true);
	});

	it("rejects a wrong password or a file without a private key", () =>
	{
		expect(() => signDte({}, certificate, "otra")).toThrow("no coincide");
		expect(() => signDte({}, "<CertificadoMH/>", password)).toThrow("clave privada");
	});
});

describe("buildInvalidation", () =>
{
	it("valid against invalidacion-schema-v3", () =>
	{
		const event = buildInvalidation({
			environment: "00",
			tenant: {
				nit: tenant.nit!, legal_name: tenant.legal_name!, mh_establishment_code: "0001", mh_pos_code: "0001",
				establishment_code: "M001", pos_code: "P001", phone: tenant.phone!, email: tenant.email!,
			},
			dte: {
				tipoDte: "03",
				codigoGeneracion: id("03").generationCode,
				selloRecibido: "2026AB12CD34EF56AB78CD90EF12AB34CD56EF78",
				numeroControl: id("03").controlNumber,
				fecEmi: "2026-11-07",
				receptor: { tipoDocumento: "36", numDocumento: "06140202901023", nombre: "Hoteles del Sol", telefono: null, correo: null },
			},
			reason: "El cliente devolvió el pedido",
			responsible: { name: "Ana Admin", docType: "13", docNumber: "04567890-1" },
			requester: { name: "Hoteles del Sol", docType: "36", docNumber: "06140202901023" },
		}, now);
		expect(validateInvalidation(event), JSON.stringify(validateInvalidation.errors)).toBe(true);
		expect(event).toMatchObject({ motivo: { tipoAnulacion: 2 } });
	});
});

describe("places catalog", () =>
{
	it("matches Hacienda's counts and every place has a known department", () =>
	{
		expect(DEPARTMENTS).toHaveLength(14);
		expect(MUNICIPALITIES).toHaveLength(44);
		expect(DISTRICTS).toHaveLength(262);
		const codes = new Set(DEPARTMENTS.map((d) => d.code));
		expect([...MUNICIPALITIES, ...DISTRICTS].every((p) => codes.has(p.department))).toBe(true);
	});
});
