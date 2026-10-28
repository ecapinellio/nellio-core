/**
 * Pure logic behind the /products catalog grid (eng review D8: everything
 * that can be wrong lives here, unit-tested; the component only renders).
 *
 *   Excel ──paste──▶ fillFromPaste() ──▶ rows[] ──▶ rowIssues() + findDuplicates()
 *                                          │              │
 *                                          │        red / "falta" cells
 *                                          ▼
 *                                 toSavePayload() (dirty rows only) ──▶ save_products()
 */
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

export interface GridRow extends RowValues
{
	/** Stable React key — new rows have no id yet. */
	key: string;
	id: string | null;
	/** Pasted unit text we couldn't map ("saco"), kept visible (design D13). */
	unitRaw: string | null;
	/** Exact text from Postgres — never round-tripped through a JS Date (µs). */
	updatedAt: string | null;
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

/**
 * Same spec as the SQL normalize_product_name(): lowercase, no accents, no
 * whitespace at all — "Cloro 5%" = "CLORO 5 %". JS \s already covers the
 * non-breaking space.
 */
export function normalizeProductName(name: string): string
{
	return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "");
}

export interface PasteResult
{
	rows: GridRow[];
	/** Lines pasted (rows filled). */
	filled: number;
	/** Columns beyond "Unidad" that were dropped (design D7). */
	extraColumns: number;
	column: GridColumn;
}

/**
 * Excel puts tabs between columns and newlines between rows. A single value
 * on a single line returns null so the input's normal paste happens.
 * Multi-line → fills down from rowIndex, creating rows; multi-column →
 * fills right from column (D7).
 */
export function fillFromPaste(
	rows: GridRow[],
	rowIndex: number,
	column: GridColumn,
	text: string,
	newKey: () => string,
): PasteResult | null
{
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[lines.length - 1].trim() === "")
	{
		lines.pop();
	}
	if (lines.length === 0 || (lines.length === 1 && !lines[0].includes("\t")))
	{
		return null;
	}

	const startCol = GRID_COLUMNS.indexOf(column);
	const next = rows.slice();
	let extraColumns = 0;

	lines.forEach((line, i) =>
	{
		const target = rowIndex + i;
		while (next.length <= target)
		{
			next.push(emptyRow(newKey()));
		}
		const cells = line.split("\t");
		extraColumns = Math.max(extraColumns, startCol + cells.length - GRID_COLUMNS.length);

		let row = { ...next[target] };
		cells.forEach((cell, j) =>
		{
			const col = GRID_COLUMNS[startCol + j];
			if (col)
			{
				row = applyPastedCell(row, col, cell);
			}
		});
		next[target] = row;
	});

	return { rows: next, filled: lines.length, extraColumns: Math.max(0, extraColumns), column };
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

export type CellIssue = { kind: "missing" } | { kind: "error"; message: string };
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

/**
 * Keys of rows whose name collides with another row (the grid holds the
 * whole catalog, so this also covers "already exists"). Rows saved and
 * untouched are never flagged — the one the user added or renamed is.
 */
export function findDuplicates(rows: GridRow[]): Map<string, string>
{
	const groups = new Map<string, GridRow[]>();
	for (const row of rows)
	{
		if (isBlank(row) || row.name.trim() === "")
		{
			continue;
		}
		const norm = normalizeProductName(row.name);
		groups.set(norm, [...(groups.get(norm) ?? []), row]);
	}

	const flagged = new Map<string, string>();
	for (const group of groups.values())
	{
		if (group.length < 2)
		{
			continue;
		}
		const changed = group.filter((r) => r.original === null || r.name !== r.original.name);
		const message = changed.length < group.length ? "Ya existe" : "Repetido";
		for (const r of changed)
		{
			flagged.set(r.key, message);
		}
	}
	return flagged;
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
	return duplicates.has(row.key) || Object.keys(rowIssues(row)).length > 0;
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
