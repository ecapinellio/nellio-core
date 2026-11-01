/**
 * Pure logic shared by every spreadsheet-style editable grid (/products,
 * /customers). An entity describes its rows through a GridModel; everything
 * here works on any row shape that has the BaseRow fields.
 *
 *   Excel ──paste──▶ fillFromPaste() ──▶ rows[] ──▶ entity issues() + findDuplicates()
 *                                          │                │
 *                                          │       red / "falta" / ⚠ cells
 *                                          ▼
 *                               entity toSavePayload() (dirty rows) ──▶ save RPC
 */

/**
 * "missing" = not filled in yet (gray "falta"; turns red on a save attempt),
 * "error" = actually wrong (red, blocks saving),
 * "warning" = worth a look but never blocks (⚠ amber text) — e.g. a NIT
 * shared by branches (customers design review D4).
 */
export type CellIssue =
	| { kind: "missing" }
	| { kind: "error"; message: string }
	| { kind: "warning"; message: string };

export type RowIssues = Partial<Record<string, CellIssue>>;

export interface BaseRow
{
	/** Stable React key — new rows have no id yet. */
	key: string;
	id: string | null;
	active: boolean;
	/** Exact text from Postgres — never round-tripped through a JS Date (µs). */
	updatedAt: string | null;
}

export interface GridModel<T extends BaseRow, C extends string>
{
	/** Pasteable columns, left to right — a multi-column paste fills in this order. */
	columns: readonly C[];
	emptyRow: (key: string) => T;
	/** A new row nobody typed into — ignored for validation and saving. */
	isBlank: (row: T) => boolean;
	isDirty: (row: T) => boolean;
	/** One pasted cell (typing updates fields directly). */
	applyPasted: (row: T, column: C, text: string) => T;
	/** The unique, human-facing name used for duplicates and search. */
	nameOf: (row: T) => string;
	/** Name as loaded; null for rows created in the grid. */
	originalNameOf: (row: T) => string | null;
}

/**
 * Same spec as the SQL normalizer: lowercase, no accents, no whitespace at
 * all — "Cloro 5%" = "CLORO 5 %". JS \s already covers the non-breaking space.
 */
export function normalizeName(name: string): string
{
	return name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, "");
}

/** The grid always ends in one blank row to type or paste into. */
export function withTrailingRow<T extends BaseRow, C extends string>(model: GridModel<T, C>, rows: T[], newKey: () => string): T[]
{
	const last = rows[rows.length - 1];
	return last && model.isBlank(last) ? rows : [...rows, model.emptyRow(newKey())];
}

export interface PasteResult<T, C>
{
	rows: T[];
	/** Lines pasted (rows filled). */
	filled: number;
	/** Columns beyond the last pasteable one that were dropped. */
	extraColumns: number;
	column: C;
}

/**
 * Excel puts tabs between columns and newlines between rows. A single value
 * on a single line returns null so the input's normal paste happens.
 * Multi-line → fills down from rowIndex, creating rows; multi-column →
 * fills right from column.
 */
export function fillFromPaste<T extends BaseRow, C extends string>(
	model: GridModel<T, C>,
	rows: T[],
	rowIndex: number,
	column: C,
	text: string,
	newKey: () => string,
): PasteResult<T, C> | null
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

	const startCol = model.columns.indexOf(column);
	const next = rows.slice();
	let extraColumns = 0;

	lines.forEach((line, i) =>
	{
		const target = rowIndex + i;
		while (next.length <= target)
		{
			next.push(model.emptyRow(newKey()));
		}
		const cells = line.split("\t");
		extraColumns = Math.max(extraColumns, startCol + cells.length - model.columns.length);

		let row = { ...next[target] };
		cells.forEach((cell, j) =>
		{
			const col = model.columns[startCol + j];
			if (col)
			{
				row = model.applyPasted(row, col, cell);
			}
		});
		next[target] = row;
	});

	return { rows: next, filled: lines.length, extraColumns: Math.max(0, extraColumns), column };
}

/**
 * Keys of rows whose name collides with another row (the grid holds the
 * whole table, so this also covers "already exists"). Rows saved and
 * untouched are never flagged — the one the user added or renamed is.
 */
export function findDuplicates<T extends BaseRow, C extends string>(model: GridModel<T, C>, rows: T[]): Map<string, string>
{
	const groups = new Map<string, T[]>();
	for (const row of rows)
	{
		const name = model.nameOf(row);
		if (model.isBlank(row) || name.trim() === "")
		{
			continue;
		}
		const norm = normalizeName(name);
		groups.set(norm, [...(groups.get(norm) ?? []), row]);
	}

	const flagged = new Map<string, string>();
	for (const group of groups.values())
	{
		if (group.length < 2)
		{
			continue;
		}
		const changed = group.filter((r) => model.originalNameOf(r) === null || model.nameOf(r) !== model.originalNameOf(r));
		const message = changed.length < group.length ? "Ya existe" : "Repetido";
		for (const r of changed)
		{
			flagged.set(r.key, message);
		}
	}
	return flagged;
}

/** Red now, or gray "falta" that turned red after a save attempt. Warnings never count. */
export function isProblemIssue(issue: CellIssue | undefined, attempted: boolean): boolean
{
	return issue?.kind === "error" || (issue?.kind === "missing" && attempted);
}

/** Anything that blocks saving this row: a duplicate, an error, or a missing field. */
export function blocksSave(issues: RowIssues, duplicate: boolean): boolean
{
	return duplicate || Object.values(issues).some((i) => i?.kind === "error" || i?.kind === "missing");
}
