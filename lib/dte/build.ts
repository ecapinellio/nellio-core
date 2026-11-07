/**
 * Builds the DTE JSON (Factura 01 / Comprobante de Crédito Fiscal 03) from an
 * order. Pure: no I/O, so it is tested against Hacienda's official JSON
 * Schemas (fe-f-v2, fe-ccf-v4 — tests/fixtures/dte-schemas). Rules: spec
 * docs/superpowers/specs/2026-11-07-dte-hacienda-design.md §2.
 */
import { amountInWords } from "@/lib/dte/letters";

export type DteType = "01" | "03";

export interface DteTenant
{
	nit: string | null;
	nrc: string | null;
	legal_name: string | null;
	commercial_name: string | null;
	cod_actividad: string | null;
	desc_actividad: string | null;
	department_code: string | null;
	municipality_code: string | null;
	district_code: string | null;
	address: string | null;
	phone: string | null;
	email: string | null;
	establishment_code: string;
	pos_code: string;
	prices_include_vat: boolean;
}

export interface DteCustomer
{
	name: string;
	legal_name: string | null;
	tax_id: string | null;
	nrc: string | null;
	cod_actividad: string | null;
	desc_actividad: string | null;
	department_code: string | null;
	municipality_code: string | null;
	district_code: string | null;
	address: string | null;
	phone: string | null;
	email: string | null;
}

export interface DteLine
{
	product: string;
	quantity: number;
	delivered_quantity: number | null;
	price_at_order: number | null;
	unit_at_order: string | null;
}

export interface DteOrder
{
	tenant: DteTenant;
	customer: DteCustomer;
	lines: DteLine[];
	/** order_deliveries.payment_method of the delivery: cash | check | transfer | credit | null. */
	payment_method: string | null;
}

export interface DteIdentity
{
	dteType: DteType;
	environment: "00" | "01";
	controlNumber: string;
	generationCode: string;
}

const VAT = 0.13;

// CAT-014 Unidad de Medida, for products.unit's values.
const UNIT_CODES: Record<string, number> = { ton: 30, kg: 34, lb: 36, l: 23, gal: 22, each: 59 };
// CAT-017 Forma de Pago.
const PAYMENT_CODES: Record<string, string> = { cash: "01", check: "04", transfer: "05" };

const round = (x: number, decimals: number) =>
{
	const f = 10 ** decimals;
	return Math.round((x + Number.EPSILON) * f) / f;
};
const digits = (s: string) => s.replace(/\D/g, "");
const clean = (s: string | null | undefined) => (s ?? "").trim() || null;
const between = (s: string | null, min: number, max: number) => (s && s.length >= min && s.length <= max ? s : null);

/** With NRC → CCF; without → Factura (spec D2). */
export function dteTypeFor(customer: Pick<DteCustomer, "nrc">): DteType
{
	return clean(customer.nrc) ? "03" : "01";
}

/** Quantity billed: what was delivered (a partial bills only that), lines with 0 left out. */
function billedLines(lines: DteLine[])
{
	return lines
		.map((l) => ({ ...l, billed: l.delivered_quantity ?? l.quantity }))
		.filter((l) => l.billed > 0);
}

function hasAddress(p: Pick<DteCustomer, "department_code" | "municipality_code" | "district_code" | "address">)
{
	return !!(p.department_code && p.municipality_code && p.district_code && clean(p.address));
}

/**
 * Data problems that keep the DTE from being built, in Spanish for the
 * operator. Empty = buildDte() can run.
 */
export function dteProblems(order: DteOrder, dteType: DteType): string[]
{
	const { tenant: t, customer: c } = order;
	const problems: string[] = [];

	const missing: string[] = [];
	if (!clean(t.nit)) missing.push("NIT");
	if (!clean(t.nrc)) missing.push("NRC");
	if (!clean(t.legal_name)) missing.push("razón social");
	if (!clean(t.cod_actividad) || !between(clean(t.desc_actividad), 5, 150)) missing.push("actividad económica");
	if (!hasAddress(t)) missing.push("dirección");
	if (!between(clean(t.phone), 8, 30)) missing.push("teléfono");
	if (!clean(t.email)) missing.push("correo");
	if (missing.length)
	{
		problems.push(`A los datos de la empresa les falta: ${missing.join(", ")}.`);
	}

	if (dteType === "03")
	{
		const cm: string[] = [];
		if (!clean(c.tax_id)) cm.push("NIT");
		if (!clean(c.cod_actividad) || !between(clean(c.desc_actividad), 5, 150)) cm.push("actividad económica");
		if (!hasAddress(c)) cm.push("dirección completa (departamento, municipio, distrito y dirección)");
		if (cm.length)
		{
			problems.push(`Para el crédito fiscal, al cliente "${c.name}" le falta: ${cm.join(", ")}.`);
		}
	}

	const lines = billedLines(order.lines);
	if (lines.length === 0)
	{
		problems.push("El pedido no tiene productos entregados.");
	}
	for (const l of lines)
	{
		if (l.price_at_order === null)
		{
			problems.push(`"${l.product}" no tiene precio.`);
		}
	}
	return problems;
}

function address(p: Pick<DteCustomer, "department_code" | "municipality_code" | "district_code" | "address">)
{
	return {
		departamento: p.department_code!,
		municipio: p.municipality_code!,
		distrito: p.district_code!,
		complemento: clean(p.address)!.slice(0, 200),
	};
}

/** Date and time in El Salvador (UTC-6, no DST). */
function localDateTime(now: Date)
{
	const local = new Date(now.getTime() - 6 * 3600_000).toISOString();
	return { fecEmi: local.slice(0, 10), horEmi: local.slice(11, 19) };
}

/** NIT: 14 digits, no dashes. DUI: "12345678-9". */
function idDocument(taxId: string): { type: "36" | "13"; number: string }
{
	const d = digits(taxId);
	return d.length === 9 ? { type: "13", number: `${d.slice(0, 8)}-${d.slice(8)}` } : { type: "36", number: d };
}

/** Call only when dteProblems() is empty. */
export function buildDte(order: DteOrder, id: DteIdentity, now: Date): Record<string, unknown>
{
	const { tenant: t, customer: c } = order;
	const isCcf = id.dteType === "03";

	const items = billedLines(order.lines).map((l, i) =>
	{
		const price = l.price_at_order!;
		const net = t.prices_include_vat ? price / (1 + VAT) : price;
		const gross = t.prices_include_vat ? price : price * (1 + VAT);
		// Factura: unit price with VAT; CCF: without (Manual Funcional V2.0).
		const precioUni = round(isCcf ? net : gross, 8);
		const ventaGravada = round(l.billed * precioUni, 8);
		const item: Record<string, unknown> = {
			numItem: i + 1,
			tipoItem: 1,
			numeroDocumento: null,
			codigo: null,
			codTributo: null,
			descripcion: l.product.slice(0, 1500),
			cantidad: l.billed,
			uniMedida: UNIT_CODES[l.unit_at_order ?? ""] ?? 59,
			precioUni,
			montoDescu: 0,
			ventaNoSuj: 0,
			ventaExenta: 0,
			ventaGravada,
			tributos: isCcf ? ["20"] : null,
			psv: 0,
			noGravado: 0,
		};
		if (!isCcf)
		{
			item.ivaItem = round(ventaGravada - ventaGravada / (1 + VAT), 8);
		}
		return item;
	});

	const totalGravada = round(items.reduce((s, i) => s + (i.ventaGravada as number), 0), 2);
	const iva = isCcf
		? round(totalGravada * VAT, 2)
		: round(items.reduce((s, i) => s + (i.ivaItem as number), 0), 2);
	const total = isCcf ? round(totalGravada + iva, 2) : totalGravada;

	// CAT-016: 1 contado, 2 crédito, 3 otro (no payment recorded).
	const payCode = PAYMENT_CODES[order.payment_method ?? ""];
	const condicionOperacion = order.payment_method === "credit" ? 2 : payCode ? 1 : 3;
	const pagos = payCode ? [{ codigo: payCode, montoPago: total, referencia: null, plazo: null, periodo: null }] : null;

	const resumen: Record<string, unknown> = {
		totalNoSuj: 0,
		totalExenta: 0,
		totalGravada,
		subTotalVentas: totalGravada,
		descuNoSuj: 0,
		descuExenta: 0,
		descuGravada: 0,
		porcentajeDescuento: 0,
		totalDescu: 0,
		tributos: isCcf ? [{ codigo: "20", descripcion: "Impuesto al Valor Agregado 13%", valor: iva }] : null,
		subTotal: totalGravada,
		...(isCcf ? { ivaPerci: 0 } : {}),
		// shortcut: no 1% VAT withholding (grandes contribuyentes); add when ECTEC's accountant confirms it applies.
		ivaRete: 0,
		montoTotalOperacion: total,
		totalNoGravado: 0,
		totalPagar: total,
		totalLetras: amountInWords(total),
		...(isCcf ? {} : { totalIva: iva }),
		saldoFavor: 0,
		condicionOperacion,
		pagos,
		numPagoElectronico: null,
		observaciones: null,
	};

	const receptorName = (clean(c.legal_name) ?? c.name).slice(0, 250);
	let receptor: Record<string, unknown>;
	if (isCcf)
	{
		receptor = {
			nit: digits(c.tax_id!),
			nrc: digits(c.nrc!),
			nombre: receptorName,
			codActividad: clean(c.cod_actividad),
			descActividad: clean(c.desc_actividad),
			nombreComercial: c.name.slice(0, 150),
			direccion: address(c),
			telefono: between(clean(c.phone), 8, 30),
			correo: between(clean(c.email), 1, 100),
		};
	}
	else
	{
		const doc = clean(c.tax_id) ? idDocument(c.tax_id!) : null;
		receptor = {
			tipoDocumento: doc?.type ?? null,
			numDocumento: doc?.number ?? null,
			nrc: null,
			nombre: receptorName,
			codActividad: between(clean(c.cod_actividad), 5, 6),
			descActividad: between(clean(c.desc_actividad), 5, 150),
			direccion: hasAddress(c) ? address(c) : null,
			telefono: between(clean(c.phone), 8, 30),
			correo: between(clean(c.email), 6, 100),
		};
	}

	return {
		identificacion: {
			version: isCcf ? 4 : 2,
			ambiente: id.environment,
			tipoDte: id.dteType,
			numeroControl: id.controlNumber,
			codigoGeneracion: id.generationCode,
			tipoModelo: 1,
			tipoOperacion: 1,
			tipoContingencia: null,
			motivoContin: null,
			...localDateTime(now),
			tipoMoneda: "USD",
		},
		documentoRelacionado: null,
		emisor: {
			nit: digits(t.nit!),
			nrc: digits(t.nrc!),
			nombre: clean(t.legal_name)!,
			codActividad: clean(t.cod_actividad)!,
			descActividad: clean(t.desc_actividad)!,
			nombreComercial: clean(t.commercial_name),
			direccion: address(t),
			telefono: clean(t.phone)!,
			correo: clean(t.email)!,
			codEstable: t.establishment_code,
			codPuntoVenta: t.pos_code,
		},
		receptor,
		otrosDocumentos: null,
		ventaTercero: null,
		cuerpoDocumento: items,
		resumen,
		apendice: null,
	};
}
