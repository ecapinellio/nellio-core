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
	/** Other fields the search box matches by digits (phone, NIT), each on its own; name only when absent. */
	searchDigitsOf?: (row: T) => readonly string[];
}

/**
 * "Guardar el mío" after a conflict: keep only the fields I actually
 * changed and take everything else from the newer saved version — otherwise
 * my stale copy silently overwrites what the other person edited (review:
 * fiscal panel / active lost on rebase).
 */
export function rebaseChangedFields<T extends BaseRow & { original: object | null }>(mine: T, saved: T, fields: readonly (keyof T & string)[]): T
{
	const next: T = { ...mine, updatedAt: saved.updatedAt, original: saved.original };
	const original = mine.original as Partial<Record<string, unknown>> | null;
	for (const field of fields)
	{
		if (original !== null && mine[field] === original[field])
		{
			next[field] = saved[field];
		}
	}
	return next;
}

/**
 * Search box match: the name (ignoring case/accents/spaces), or — when the
 * query has 4+ digits — the row's phone/NIT digits ("2222-3333" = "22223333").
 */
export function matchesSearch<T extends BaseRow, C extends string>(model: GridModel<T, C>, row: T, search: string): boolean
{
	const needle = normalizeName(search);
	if (needle === "" || normalizeName(model.nameOf(row)).includes(needle))
	{
		return true;
	}
	const digits = search.replace(/\D/g, "");
	return digits.length >= 4 && model.searchDigitsOf !== undefined
		&& model.searchDigitsOf(row).some((field) => field.replace(/\D/g, "").includes(digits));
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
	/** The first line was the sheet's header row ("Nombre, Teléfono…") and was skipped. */
	skippedHeader: boolean;
	column: C;
}

/**
 * Excel/Sheets clipboard text: tab-separated, one line per row, and a cell
 * containing a line break (Alt+Enter), tab or quote comes wrapped in quotes
 * with "" for a literal quote. Splitting on "\n" alone turned such a cell
 * into a bogus extra row (review). Line breaks inside a cell become ", "
 * since grid cells are single-line.
 */
export function parseTsv(text: string): string[][]
{
	const t = text.replace(/\r\n?/g, "\n");
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let cellStart = true;
	let i = 0;
	while (i < t.length)
	{
		const ch = t[i];
		if (cellStart && ch === "\"")
		{
			let j = i + 1;
			let value = "";
			let closed = false;
			while (j < t.length)
			{
				if (t[j] === "\"")
				{
					if (t[j + 1] === "\"")
					{
						value += "\"";
						j += 2;
						continue;
					}
					closed = true;
					break;
				}
				value += t[j];
				j++;
			}
			// Only a properly closed field followed by a separator is quoted;
			// anything else is a literal leading quote.
			if (closed && (j + 1 === t.length || t[j + 1] === "\t" || t[j + 1] === "\n"))
			{
				cell = value.replace(/\s*\n\s*/g, ", ");
				cellStart = false;
				i = j + 1;
				continue;
			}
		}
		cellStart = false;
		if (ch === "\t")
		{
			row.push(cell);
			cell = "";
			cellStart = true;
		}
		else if (ch === "\n")
		{
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			cellStart = true;
		}
		else
		{
			cell += ch;
		}
		i++;
	}
	if (cell !== "" || row.length > 0 || !cellStart)
	{
		row.push(cell);
		rows.push(row);
	}
	return rows;
}

/**
 * A copied Excel range often includes its header row. It's a header when
 * some cell is one of our column labels (or a known alias) and no cell has
 * a digit — a real row always has a name, and labels never have numbers.
 */
export function isHeaderLine(line: string, labels: readonly string[]): boolean
{
	const known = new Set(labels.map(normalizeName));
	const cells = line.split("\t").map((c) => c.trim()).filter((c) => c !== "");
	return cells.length > 0
		&& !cells.some((c) => /\d/.test(c))
		&& cells.some((c) => known.has(normalizeName(c)));
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
	headerLabels: readonly string[] = [],
): PasteResult<T, C> | null
{
	const lines = parseTsv(text);
	while (lines.length > 0 && lines[lines.length - 1].every((cell) => cell.trim() === ""))
	{
		lines.pop();
	}
	// One plain cell is a normal paste — let the input handle it. (A quoted
	// one, "Col. Escalón↵San Salvador", still needs unquoting here.)
	if (lines.length === 0 || (lines.length === 1 && lines[0].length === 1 && !text.trimStart().startsWith("\"")))
	{
		return null;
	}
	const skippedHeader = isHeaderLine(lines[0].join("\t"), headerLabels);
	if (skippedHeader)
	{
		lines.shift();
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
		const cells = line;
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

	return { rows: next, filled: lines.length, extraColumns: Math.max(0, extraColumns), skippedHeader, column };
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
