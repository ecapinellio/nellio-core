/**
 * Customers' rows on top of the generic grid (lib/grid/core.ts). The grid
 * shows Nombre | Teléfono | Dirección | NIT; the fiscal fields live in the
 * same row (pasteable: false) and are edited in a side panel, so one save
 * carries both and a grid save never wipes panel edits (outside voice #2).
 */
import type { BaseRow, CellIssue, GridModel, RowIssues } from "@/lib/grid/core";
import { isValidActivityCode, isValidEmail, normalizeNrc, normalizeTaxId, phoneLooksIncomplete } from "@/lib/customers/parse";

export const CUSTOMER_GRID_COLUMNS = ["name", "phone", "address", "tax_id"] as const;
export type CustomerColumn = (typeof CUSTOMER_GRID_COLUMNS)[number];

export const FISCAL_FIELDS = ["legal_name", "nrc", "cod_actividad", "desc_actividad", "email"] as const;
export type FiscalField = (typeof FISCAL_FIELDS)[number];

export const FISCAL_LABELS: Record<FiscalField, string> = {
	legal_name: "Razón social",
	nrc: "NRC",
	cod_actividad: "Código de actividad",
	desc_actividad: "Giro",
	email: "Correo",
};

export const MAX_CUSTOMER_NAME = 200;
export const MAX_PHONE = 100;
export const MAX_ADDRESS = 500;
/** Mirrors save_customers()' cap. */
export const MAX_CUSTOMER_SAVE_ROWS = 1000;

type TextField = CustomerColumn | FiscalField;
export const TEXT_FIELDS: readonly TextField[] = [...CUSTOMER_GRID_COLUMNS, ...FISCAL_FIELDS];

type CustomerValues = Record<TextField, string> & { active: boolean };

export interface CustomerRow extends CustomerValues, BaseRow
{
	/** The NIT/DUI got its Excel-dropped leading zero back ("se agregó un 0"). */
	taxIdPadded: boolean;
	/** Values as loaded; null for rows created in the grid. */
	original: CustomerValues | null;
}

export interface CustomerRecord
{
	id: string;
	name: string;
	phone: string | null;
	address: string | null;
	tax_id: string | null;
	legal_name: string | null;
	nrc: string | null;
	cod_actividad: string | null;
	desc_actividad: string | null;
	email: string | null;
	active: boolean;
	updated_at: string;
}

export function rowFromCustomer(record: CustomerRecord): CustomerRow
{
	const values = { active: record.active } as CustomerValues;
	for (const field of TEXT_FIELDS)
	{
		values[field] = record[field] ?? "";
	}
	return { key: record.id, id: record.id, updatedAt: record.updated_at, taxIdPadded: false, original: values, ...values };
}

export function emptyCustomerRow(key: string): CustomerRow
{
	const values = { active: true } as CustomerValues;
	for (const field of TEXT_FIELDS)
	{
		values[field] = "";
	}
	return { key, id: null, updatedAt: null, taxIdPadded: false, original: null, ...values };
}

export function isBlankCustomer(row: CustomerRow): boolean
{
	return row.id === null && TEXT_FIELDS.every((field) => row[field].trim() === "");
}

export function isDirtyCustomer(row: CustomerRow): boolean
{
	if (row.original === null)
	{
		return !isBlankCustomer(row);
	}
	const o = row.original;
	return row.active !== o.active || TEXT_FIELDS.some((field) => row[field] !== o[field]);
}

/** New row, or this field differs from what was loaded. */
function changed(row: CustomerRow, field: TextField): boolean
{
	return row.original === null || row[field] !== row.original[field];
}

export function applyPastedCustomerCell(row: CustomerRow, column: CustomerColumn, text: string): CustomerRow
{
	const value = text.trim();
	if (column === "tax_id")
	{
		// Valid → canonical form (and remember a restored zero); invalid →
		// kept as pasted so the red cell shows what Excel had.
		const tax = value === "" ? null : normalizeTaxId(value);
		return tax ? { ...row, tax_id: tax.value, taxIdPadded: tax.padded } : { ...row, tax_id: value, taxIdPadded: false };
	}
	return { ...row, [column]: value };
}

export const customerGridModel: GridModel<CustomerRow, CustomerColumn> = {
	columns: CUSTOMER_GRID_COLUMNS,
	emptyRow: emptyCustomerRow,
	isBlank: isBlankCustomer,
	isDirty: isDirtyCustomer,
	applyPasted: applyPastedCustomerCell,
	nameOf: (row) => row.name,
	originalNameOf: (row) => row.original?.name ?? null,
	searchDigitsOf: (row) => [row.phone, row.tax_id],
};

/** Who holds each NIT/DUI — over ALL loaded rows, inactive included (design D5). */
export interface CustomerContext
{
	byTaxId: Map<string, CustomerRow[]>;
}

export function buildCustomerContext(rows: CustomerRow[]): CustomerContext
{
	const byTaxId = new Map<string, CustomerRow[]>();
	for (const row of rows)
	{
		const tax = row.tax_id.trim() === "" ? null : normalizeTaxId(row.tax_id);
		if (tax)
		{
			byTaxId.set(tax.value, [...(byTaxId.get(tax.value) ?? []), row]);
		}
	}
	return { byTaxId };
}

function othersWithTaxId(row: CustomerRow, ctx: CustomerContext): CustomerRow[]
{
	const tax = row.tax_id.trim() === "" ? null : normalizeTaxId(row.tax_id);
	return tax ? (ctx.byTaxId.get(tax.value) ?? []).filter((r) => r.key !== row.key) : [];
}

/** First problem among the panel's fields, shown on the row's Fiscal cell (design D6). */
function fiscalIssue(row: CustomerRow): CellIssue | undefined
{
	if (changed(row, "nrc") && row.nrc.trim() !== "" && normalizeNrc(row.nrc) === null)
	{
		return { kind: "error", message: "NRC inválido" };
	}
	if (changed(row, "cod_actividad") && row.cod_actividad.trim() !== "" && !isValidActivityCode(row.cod_actividad))
	{
		return { kind: "error", message: "Código de actividad inválido" };
	}
	if (changed(row, "email") && row.email.trim() !== "" && !isValidEmail(row.email))
	{
		return { kind: "error", message: "Correo inválido" };
	}
	if (row.legal_name.length > MAX_CUSTOMER_NAME || row.desc_actividad.length > MAX_CUSTOMER_NAME)
	{
		return { kind: "error", message: "Texto demasiado largo" };
	}
	return undefined;
}

/**
 * Three severities (design D4): error (red, blocks), missing (gray "falta"),
 * warning (⚠, never blocks). Formats are only checked on new or changed
 * values, so a legacy NIT doesn't make a row uneditable (outside voice #10).
 */
export function customerIssues(row: CustomerRow, ctx: CustomerContext): RowIssues
{
	const issues: RowIssues = {};
	if (isBlankCustomer(row))
	{
		return issues;
	}

	if (row.name.trim() === "")
	{
		issues.name = { kind: "missing" };
	}
	else if (row.name.length > MAX_CUSTOMER_NAME)
	{
		issues.name = { kind: "error", message: `Máximo ${MAX_CUSTOMER_NAME} caracteres` };
	}

	if (row.phone.length > MAX_PHONE)
	{
		issues.phone = { kind: "error", message: `Máximo ${MAX_PHONE} caracteres` };
	}
	else if (changed(row, "phone") && phoneLooksIncomplete(row.phone))
	{
		issues.phone = { kind: "warning", message: "¿Teléfono incompleto?" };
	}

	if (row.address.length > MAX_ADDRESS)
	{
		issues.address = { kind: "error", message: `Máximo ${MAX_ADDRESS} caracteres` };
	}

	if (row.tax_id.trim() !== "" && changed(row, "tax_id"))
	{
		const others = othersWithTaxId(row, ctx);
		if (normalizeTaxId(row.tax_id) === null)
		{
			issues.tax_id = { kind: "error", message: "NIT o DUI inválido" };
		}
		else if (others.length > 0)
		{
			// Only while loading or changing a NIT (D5) — branches share NITs.
			issues.tax_id = { kind: "warning", message: `Mismo NIT que ${others[0].name || "otra fila"}` };
		}
	}

	const fiscal = fiscalIssue(row);
	if (fiscal)
	{
		issues.fiscal = fiscal;
	}

	return issues;
}

/** Quiet note for saved, unchanged rows sharing a NIT: "Comparte NIT con 4 más". */
export function sharedTaxIdNote(row: CustomerRow, ctx: CustomerContext): string | null
{
	if (row.tax_id.trim() === "" || changed(row, "tax_id"))
	{
		return null;
	}
	const others = othersWithTaxId(row, ctx).length;
	return others > 0 ? `Comparte NIT con ${others} más` : null;
}

/** How many of the panel's fiscal fields are filled (the "Faltan N" chip). */
export function fiscalFilled(row: CustomerRow): number
{
	return FISCAL_FIELDS.filter((field) => row[field].trim() !== "").length;
}

/** Saved with only a name — a capture quick-add ("Solo nombre", design D7). */
export function isNameOnly(row: CustomerRow): boolean
{
	return row.original !== null && row.original.phone === "" && row.original.address === "" && row.original.tax_id === "";
}

export interface CustomerSaveRow
{
	id: string | null;
	name: string;
	phone: string | null;
	address: string | null;
	tax_id: string | null;
	legal_name: string | null;
	nrc: string | null;
	cod_actividad: string | null;
	desc_actividad: string | null;
	email: string | null;
	active: boolean;
	updated_at: string | null;
}

/** Dirty, non-blank rows only, every field included. Callers check problems first. */
export function toCustomerPayload(rows: CustomerRow[]): CustomerSaveRow[]
{
	const text = (value: string) => (value.trim() === "" ? null : value.trim());
	return rows.filter(isDirtyCustomer).map((row) => ({
		id: row.id,
		name: row.name.trim(),
		phone: text(row.phone),
		address: text(row.address),
		tax_id: text(row.tax_id === "" ? "" : (normalizeTaxId(row.tax_id)?.value ?? row.tax_id)),
		legal_name: text(row.legal_name),
		nrc: text(row.nrc === "" ? "" : (normalizeNrc(row.nrc) ?? row.nrc)),
		cod_actividad: text(row.cod_actividad),
		desc_actividad: text(row.desc_actividad),
		email: text(row.email),
		active: row.active,
		updated_at: row.updatedAt,
	}));
}

/**
 * Server-side re-check (the Server Action can't trust the grid). Format
 * rules that depend on "did it change?" are save_customers()' job — it has
 * the stored values.
 */
export function customerSaveRowError(row: CustomerSaveRow): string | null
{
	const name = typeof row?.name === "string" ? row.name.trim() : "";
	if (name === "")
	{
		return "Falta el nombre de un cliente.";
	}
	if (name.length > MAX_CUSTOMER_NAME)
	{
		return `El nombre "${name.slice(0, 40)}" es demasiado largo.`;
	}
	for (const field of ["phone", "address", ...FISCAL_FIELDS, "tax_id"] as const)
	{
		const value = row[field];
		if (value !== null && typeof value !== "string")
		{
			return `Dato inválido en "${name}".`;
		}
	}
	if ((row.phone?.length ?? 0) > MAX_PHONE || (row.address?.length ?? 0) > MAX_ADDRESS)
	{
		return `Un dato de "${name}" es demasiado largo.`;
	}
	if (typeof row.active !== "boolean")
	{
		return `Estado inválido para "${name}".`;
	}
	return null;
}
