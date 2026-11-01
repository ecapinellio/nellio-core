/**
 * The product catalog's rows on top of the generic grid (lib/grid/core.ts):
 * the row shape, price/unit parsing and validation, and the save payload.
 * The generic paste / duplicate / blank logic is the shared one — these
 * exports keep their product-shaped signatures for the catalog and its tests.
 */
import * as core from "@/lib/grid/core";
import { MAX_PRICE, parsePrice, priceErrorMessage } from "@/lib/products/parse";
import { isProductUnit, parseUnit, type ProductUnit } from "@/lib/products/units";

export const GRID_COLUMNS = ["name", "price", "unit"] as const;
export type GridColumn = (typeof GRID_COLUMNS)[number];

export const MAX_NAME_LENGTH = 200;
/** Mirrors save_products()' cap. */
export const MAX_SAVE_ROWS = 1000;

interface RowValues
{
	name: string;
	price: string;
	unit: ProductUnit | "";
	active: boolean;
}

export interface GridRow extends RowValues, core.BaseRow
{
	/** Pasted unit text we couldn't map ("saco"), kept visible (design D13). */
	unitRaw: string | null;
	/** Values as loaded; null for rows created in the grid. */
	original: RowValues | null;
}

export interface CatalogProduct
{
	id: string;
	name: string;
	price_per_unit: number | null;
	unit: string | null;
	active: boolean;
	updated_at: string;
}

export function rowFromProduct(product: CatalogProduct): GridRow
{
	const values: RowValues = {
		name: product.name,
		price: product.price_per_unit === null ? "" : Number(product.price_per_unit).toFixed(2),
		unit: (product.unit ?? "") as ProductUnit | "",
		active: product.active,
	};
	return { key: product.id, id: product.id, unitRaw: null, updatedAt: product.updated_at, original: values, ...values };
}

export function emptyRow(key: string): GridRow
{
	return { key, id: null, name: "", price: "", unit: "", unitRaw: null, active: true, updatedAt: null, original: null };
}

/** A new row nobody typed into — ignored for validation and saving. */
export function isBlank(row: GridRow): boolean
{
	return row.id === null && row.name.trim() === "" && row.price.trim() === "" && row.unit === "" && !row.unitRaw;
}

export function isDirty(row: GridRow): boolean
{
	if (row.original === null)
	{
		return !isBlank(row);
	}
	const o = row.original;
	return row.name !== o.name || row.price !== o.price || row.unit !== o.unit || row.active !== o.active || row.unitRaw !== null;
}

export type PasteResult = core.PasteResult<GridRow, GridColumn>;

/** Fills down / right from a paste (design D7). See core.fillFromPaste. */
export function fillFromPaste(
	rows: GridRow[],
	rowIndex: number,
	column: GridColumn,
	text: string,
	newKey: () => string,
): PasteResult | null
{
	return core.fillFromPaste(productGridModel, rows, rowIndex, column, text, newKey);
}

/** Applies one pasted value to a cell (typing updates fields directly). */
export function applyPastedCell(row: GridRow, column: GridColumn, value: string): GridRow
{
	switch (column)
	{
		case "name":
			return { ...row, name: value.trim() };
		case "price":
			return { ...row, price: value.trim() };
		case "unit":
		{
			const text = value.trim();
			if (text === "")
			{
				return { ...row, unit: "", unitRaw: null };
			}
			const unit = parseUnit(text);
			return unit ? { ...row, unit, unitRaw: null } : { ...row, unit: "", unitRaw: text };
		}
	}
}

export type CellIssue = core.CellIssue;
export type RowIssues = Partial<Record<GridColumn, CellIssue>>;

/**
 * "missing" = not filled in yet (gray "falta", design D6); "error" = actually
 * wrong (red). Price/unit may stay empty on a row that was saved without
 * them (a capture quick-add) — outside voice #6.
 */
export function rowIssues(row: GridRow): RowIssues
{
	const issues: RowIssues = {};
	if (isBlank(row))
	{
		return issues;
	}

	if (row.name.trim() === "")
	{
		issues.name = { kind: "missing" };
	}
	else if (row.name.length > MAX_NAME_LENGTH)
	{
		issues.name = { kind: "error", message: `Máximo ${MAX_NAME_LENGTH} caracteres` };
	}

	const keepsNullPrice = row.original !== null && row.original.price === "" && row.price.trim() === "";
	if (!keepsNullPrice)
	{
		const price = parsePrice(row.price);
		if (!price.ok)
		{
			issues.price = price.reason === "empty" ? { kind: "missing" } : { kind: "error", message: priceErrorMessage(price) };
		}
	}

	if (row.unitRaw)
	{
		issues.unit = { kind: "error", message: `‘${row.unitRaw}’ no reconocida` };
	}
	else if (row.unit === "" && !(row.original !== null && row.original.unit === ""))
	{
		issues.unit = { kind: "missing" };
	}

	return issues;
}

/** Rows whose name collides with another (the catalog's "Ya existe" / "Repetido"). */
export function findDuplicates(rows: GridRow[]): Map<string, string>
{
	return core.findDuplicates(productGridModel, rows);
}

export interface SaveRow
{
	id: string | null;
	name: string;
	price_per_unit: number | null;
	unit: ProductUnit | null;
	active: boolean;
	updated_at: string | null;
}

/** Problem = any red cell, or any "falta" cell (those turn red on save). */
export function hasProblems(row: GridRow, duplicates: Map<string, string>): boolean
{
	return core.blocksSave(rowIssues(row), duplicates.has(row.key));
}

/**
 * Server-side re-check of one already-parsed row (the Server Action can't
 * trust the grid). Same rules as rowIssues(), minus what needs the loaded
 * original — save_products() checks "price may stay null" against the DB.
 */
export function saveRowError(row: SaveRow): string | null
{
	const name = typeof row?.name === "string" ? row.name.trim() : "";
	if (name === "")
	{
		return "Falta el nombre de un producto.";
	}
	if (name.length > MAX_NAME_LENGTH)
	{
		return `El nombre "${name.slice(0, 40)}" es demasiado largo.`;
	}
	if (row.price_per_unit !== null && !(typeof row.price_per_unit === "number" && row.price_per_unit > 0))
	{
		return `El precio de "${name}" debe ser mayor que cero.`;
	}
	if (row.price_per_unit !== null && (row.price_per_unit > MAX_PRICE || Math.round(row.price_per_unit * 100) / 100 !== row.price_per_unit))
	{
		return `El precio de "${name}" no es válido (máximo 99,999,999.99 y 2 decimales).`;
	}
	if (row.unit !== null && !isProductUnit(row.unit))
	{
		return `La unidad de "${name}" no es válida.`;
	}
	if (row.id === null && (row.price_per_unit === null || row.unit === null))
	{
		return `Falta el precio o la unidad de "${name}".`;
	}
	if (typeof row.active !== "boolean")
	{
		return `Estado inválido para "${name}".`;
	}
	return null;
}

/** Dirty, non-blank rows only. Callers must check hasProblems first. */
export function toSavePayload(rows: GridRow[]): SaveRow[]
{
	return rows.filter(isDirty).map((row) =>
	{
		const price = parsePrice(row.price);
		return {
			id: row.id,
			name: row.name.trim(),
			price_per_unit: price.ok ? price.value : null,
			unit: row.unit === "" ? null : row.unit,
			active: row.active,
			updated_at: row.updatedAt,
		};
	});
}

/** How the generic grid sees a product row. */
export const productGridModel: core.GridModel<GridRow, GridColumn> = {
	columns: GRID_COLUMNS,
	emptyRow,
	isBlank,
	isDirty,
	applyPasted: applyPastedCell,
	nameOf: (row) => row.name,
	originalNameOf: (row) => row.original?.name ?? null,
};
