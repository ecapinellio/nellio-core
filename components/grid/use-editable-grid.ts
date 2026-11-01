"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	blocksSave,
	fillFromPaste,
	matchesSearch,
	findDuplicates,
	isProblemIssue,
	normalizeName,
	withTrailingRow,
	type BaseRow,
	type GridModel,
	type RowIssues,
} from "@/lib/grid/core";
import { useLeaveGuard } from "@/hooks/use-leave-guard";
import type { ConflictChoice, GridConflict } from "@/components/grid/conflict-dialog";

export type SaveResult<K> =
	| { status: "saved"; saved: number }
	| { status: "conflicts"; conflicts: K[] }
	| { status: "error"; error: string };

export interface GridToast
{
	id: number;
	text: string;
	showProblems?: boolean;
}

export interface PastePrompt<C>
{
	key: string;
	column: C;
	text: string;
	renamed: number;
}

/**
 * model, fromRecord, buildContext, issuesOf and incomplete are read during
 * render — pass stable (module-level) functions, not inline closures.
 */
export interface EditableGridOptions<T extends BaseRow, C extends string, R, S, K extends GridConflict, X>
{
	model: GridModel<T, C>;
	/** Rows as the server sent them; a new array (after a save) resets the grid. */
	records: R[];
	fromRecord: (record: R) => T;
	/** The row as someone else saved it, for the conflict "use theirs" choice. */
	fromConflict: (conflict: K) => T;
	/**
	 * "Guardar el mío": keep my edits, but against the saved row's
	 * updated_at and values as the new baseline, so the re-save wins.
	 */
	rebaseOnto: (mine: T, saved: T) => T;
	/** Cross-row facts computed once per render (e.g. which NITs are shared). */
	buildContext: (rows: T[]) => X;
	issuesOf: (row: T, ctx: X) => RowIssues;
	/** The pasteable name column — pasting over saved names asks first. */
	nameColumn: C;
	columnLabels: Record<C, string>;
	/** Extra header spellings to recognize in a pasted header row ("Cliente", "DUI"…). */
	headerAliases?: readonly string[];
	/** Entity-specific counts for the paste toast, e.g. "2 precios por revisar". */
	pasteSummary: (touched: T[], info: { duplicates: Map<string, string>; ctx: X }) => { parts: string[]; attention: number };
	/** The entity's "incomplete" filter chip ("Sin precio" / "Solo nombre"). */
	incomplete: (row: T) => boolean;
	toPayload: (rows: T[]) => S[];
	save: (payload: S[]) => Promise<SaveResult<K>>;
	nouns: { one: string; many: string };
	leaveWarning: string;
	/** Extra resets when the server sends fresh records (e.g. close a sheet). */
	onReset?: (records: R[]) => void;
}

function headerLabelsOf(o: { columnLabels: Record<string, string>; headerAliases?: readonly string[] }): string[]
{
	return [...Object.values(o.columnLabels), ...(o.headerAliases ?? [])];
}

function plural(n: number, one: string, many: string): string
{
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every bit of state behind an editable grid, shared by /products and
 * /customers (customers eng review D2: extracted from the catalog with no
 * behavior change). Components render; this owns rows, filters, paste,
 * saving and conflicts.
 *
 *   rows[] (whole table + new rows) ──filters──▶ visible ──▶ memo row components
 *        │                                           ▲
 *        │ paste / typing / entity edits ────────────┘
 *        ▼
 *   save() ──▶ saved → toast; the server re-render resets rows
 *          └─▶ conflicts → ConflictDialog → resolveConflicts() → save() again
 */
export function useEditableGrid<T extends BaseRow, C extends string, R, S, K extends GridConflict, X>(
	options: EditableGridOptions<T, C, R, S, K, X>,
)
{
	// Used during render, so these must be stable (module-level) functions.
	const { model, records, fromRecord, buildContext, issuesOf, incomplete } = options;
	// Latest options without re-creating callbacks (they're inline per render).
	const opts = useRef(options);
	useEffect(() =>
	{
		opts.current = options;
	});

	const keyCounter = useRef(1);
	const newKey = useCallback(() => `new-${keyCounter.current++}`, []);
	const initialRows = useCallback(
		(list: R[]) => [...list.map(fromRecord), model.emptyRow("new-0")],
		[fromRecord, model],
	);

	const [rows, setRows] = useState(() => initialRows(records));
	const [search, setSearch] = useState("");
	const [onlyIncomplete, setOnlyIncomplete] = useState(false);
	const [showInactive, setShowInactive] = useState(false);
	// Rows that had problems when the filter was turned on — a snapshot, so a
	// row being fixed doesn't vanish (and drop focus) mid-typing.
	const [problemFilter, setProblemFilter] = useState<Set<string> | null>(null);
	const onlyProblems = problemFilter !== null;
	const [attempted, setAttempted] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [toast, setToast] = useState<GridToast | null>(null);
	const [conflicts, setConflicts] = useState<K[] | null>(null);
	const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
	const [pastePrompt, setPastePrompt] = useState<PastePrompt<C> | null>(null);

	// Fresh rows whenever the server sends new records (after a save's
	// revalidatePath) — adjusted during render, not in an effect.
	const [shownFor, setShownFor] = useState(records);
	if (records !== shownFor)
	{
		setShownFor(records);
		setRows(initialRows(records));
		setAttempted(false);
		setSaving(false);
		options.onReset?.(records);
	}

	const ctx = useMemo(() => buildContext(rows), [buildContext, rows]);
	const duplicates = useMemo(() => findDuplicates(model, rows), [model, rows]);
	const dirty = useMemo(() => rows.filter(model.isDirty), [model, rows]);
	const problemRows = useMemo(
		() => rows.filter((r) => duplicates.has(r.key) || Object.values(issuesOf(r, ctx)).some((i) => isProblemIssue(i, attempted))),
		[rows, duplicates, ctx, attempted, issuesOf],
	);

	const visible = useMemo(() =>
	{
		const needle = normalizeName(search);
		return rows.filter((r) =>
		{
			if (model.isBlank(r))
			{
				return !onlyProblems && !onlyIncomplete && needle === "";
			}
			if (problemFilter)
			{
				return problemFilter.has(r.key);
			}
			if (!matchesSearch(model, r, search))
			{
				return false;
			}
			if (onlyIncomplete && !incomplete(r))
			{
				return false;
			}
			// A row deactivated in this session stays visible until saved.
			return r.active || showInactive || model.isDirty(r);
		});
	}, [model, rows, search, onlyIncomplete, showInactive, onlyProblems, problemFilter, incomplete]);

	useLeaveGuard(dirty.length > 0, options.leaveWarning);

	// Handlers read the latest state through a ref so they stay stable and
	// memoized rows don't re-render on every keystroke elsewhere.
	const filtering = search !== "" || onlyIncomplete || onlyProblems;
	const latest = useRef({ rows, visible, filtering });
	useEffect(() =>
	{
		latest.current = { rows, visible, filtering };
	});

	const showToast = useCallback((text: string, showProblems = false) =>
	{
		setToast({ id: Date.now(), text, showProblems });
	}, []);

	useEffect(() =>
	{
		if (!toast)
		{
			return;
		}
		const timer = setTimeout(() => setToast(null), toast.showProblems ? 6000 : 4000);
		return () => clearTimeout(timer);
	}, [toast]);

	const updateRow = useCallback((key: string, update: (row: T) => T) =>
	{
		setRows((prev) => withTrailingRow(model, prev.map((r) => (r.key === key ? update(r) : r)), newKey));
	}, [model, newKey]);

	/**
	 * Fills rows from a paste and shows the summary toast.
	 * key = row pasted into, or null for "add as new rows" (starts at the
	 * trailing blank row, ignoring filters).
	 */
	const applyPaste = useCallback((key: string | null, column: C, text: string): boolean =>
	{
		const { rows: all, visible: shownRows, filtering: isFiltering } = latest.current;
		const shown = key === null ? all : shownRows;
		const start = key === null ? all.findIndex(model.isBlank) : shown.findIndex((r) => r.key === key);
		// Fill down the rows the user SEES (filters may hide some).
		const result = fillFromPaste(model, shown, start, column, text, newKey, headerLabelsOf(opts.current));
		if (!result)
		{
			return false;
		}
		const updated = new Map(result.rows.map((r) => [r.key, r]));
		const known = new Set(all.map((r) => r.key));
		const merged = all.map((r) => updated.get(r.key) ?? r).filter((r) => !(model.isBlank(r) && !updated.has(r.key)));
		// Under a search/filter, new rows would be created hidden (no name
		// yet, so the filter drops them) and then block saving unseen —
		// so a filtered paste only fills the rows on screen.
		const filtered = key !== null && isFiltering;
		const created = result.rows.filter((r) => !known.has(r.key));
		const added = filtered ? [] : created;
		const dropped = filtered ? created.length : 0;
		const next = withTrailingRow(model, [...merged, ...added], newKey);
		setRows(next);

		const o = opts.current;
		const touched = result.rows.slice(start, start + result.filled - dropped);
		const dupes = findDuplicates(model, next);
		const nDup = touched.filter((r) => dupes.has(r.key)).length;
		const entity = o.pasteSummary(touched, { duplicates: dupes, ctx: o.buildContext(next) });
		const parts = [`Pegaste ${plural(result.filled - dropped, "fila", "filas")} en ${o.columnLabels[column]}`];
		if (result.skippedHeader) parts.push("se omitió la fila de encabezados");
		if (dropped) parts.push(`${plural(dropped, "fila no entró", "filas no entraron")} (quita el filtro para agregar filas nuevas)`);
		if (nDup) parts.push(plural(nDup, "repetido", "repetidos"));
		parts.push(...entity.parts);
		if (result.extraColumns) parts.push(result.extraColumns === 1 ? "se ignoró 1 columna extra" : `se ignoraron ${result.extraColumns} columnas extra`);
		showToast(parts.join(" · "), nDup + entity.attention > 0);
		return true;
	}, [model, newKey, showToast]);

	/** A row's onPaste: pasting names over saved rows renames them, so ask first. */
	const requestPaste = useCallback((key: string, column: C, text: string): boolean =>
	{
		if (column === opts.current.nameColumn)
		{
			const shown = latest.current.visible;
			const start = shown.findIndex((r) => r.key === key);
			let probe = 0;
			const preview = fillFromPaste(model, shown, start, column, text, () => `probe-${probe++}`, headerLabelsOf(opts.current));
			if (!preview)
			{
				return false;
			}
			const renamed = preview.rows.slice(start, start + preview.filled).filter((r, i) =>
			{
				const before = shown[start + i];
				return before !== undefined && model.originalNameOf(before) !== null && model.nameOf(before) !== model.nameOf(r);
			}).length;
			if (renamed > 0)
			{
				setPastePrompt({ key, column, text, renamed });
				return true;
			}
		}
		return applyPaste(key, column, text);
	}, [model, applyPaste]);

	const save = useCallback(async (source: T[]) =>
	{
		const o = opts.current;
		setAttempted(true);
		setSaveError(null);
		const dupes = findDuplicates(model, source);
		const sourceCtx = o.buildContext(source);
		const blocked = source.filter((r) => !model.isBlank(r) && model.isDirty(r) && blocksSave(o.issuesOf(r, sourceCtx), dupes.has(r.key)));
		if (blocked.length > 0)
		{
			setProblemFilter(new Set(blocked.map((r) => r.key)));
			requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
			return;
		}

		const payload = o.toPayload(source);
		if (payload.length === 0)
		{
			return;
		}

		setSaving(true);
		try
		{
			const result = await o.save(payload);
			if (result.status === "saved")
			{
				showToast(result.saved === 1 ? `1 ${o.nouns.one} guardado` : `${result.saved} ${o.nouns.many} guardados`);
				setProblemFilter(null);
				// saving stays true until the revalidated records arrive and reset the grid.
				return;
			}
			setSaving(false);
			if (result.status === "conflicts")
			{
				setChoices({});
				setConflicts(result.conflicts);
				return;
			}
			setSaveError(result.error);
		}
		catch
		{
			setSaving(false);
			setSaveError("No se pudo guardar. Revisa tu conexión e intenta de nuevo.");
		}
	}, [model, showToast]);

	function resolveConflicts(next: Record<string, ConflictChoice>)
	{
		setChoices(next);
		if (!conflicts || conflicts.some((c) => !next[c.id]))
		{
			return;
		}
		const byId = new Map(conflicts.map((c) => [c.id, c]));
		const resolved = latest.current.rows.map((r) =>
		{
			const c = r.id ? byId.get(r.id) : undefined;
			if (!c)
			{
				return r;
			}
			const theirs = options.fromConflict(c);
			// "theirs": take the saved version as-is (row becomes clean).
			return next[c.id] === "theirs" ? { ...theirs, key: r.key } : options.rebaseOnto(r, theirs);
		});
		setRows(resolved);
		setConflicts(null);
		void save(resolved);
	}

	function discard()
	{
		if (window.confirm(`¿Descartar ${dirty.length === 1 ? "1 cambio" : `${dirty.length} cambios`}?`))
		{
			setRows(initialRows(records));
			setAttempted(false);
			setProblemFilter(null);
			setSaveError(null);
		}
	}

	/** Phone edit sheet: apply one row (new or existing) and save right away. */
	function saveRow(row: T)
	{
		const exists = rows.some((r) => r.key === row.key);
		const next = withTrailingRow(model, exists ? rows.map((r) => (r.key === row.key ? row : r)) : [...rows.filter((r) => !model.isBlank(r)), row], newKey);
		setRows(next);
		void save(next);
	}

	/** "Ya existe" for a name typed in the phone sheet. */
	const nameTaken = useCallback((name: string, key: string) =>
	{
		const norm = normalizeName(name);
		return norm && rows.some((r) => r.key !== key && !model.isBlank(r) && normalizeName(model.nameOf(r)) === norm) ? "Ya existe" : undefined;
	}, [model, rows]);

	return {
		rows, setRows, newKey, visible, ctx, duplicates, dirty, problemRows,
		newCount: dirty.filter((r) => r.id === null).length,
		search, setSearch, onlyIncomplete, setOnlyIncomplete, showInactive, setShowInactive,
		problemFilter, setProblemFilter, onlyProblems, filtering,
		attempted, saving, saveError, toast, setToast, conflicts, setConflicts, choices,
		pastePrompt, setPastePrompt, latest,
		updateRow, applyPaste, requestPaste, save, resolveConflicts, discard, saveRow, nameTaken,
		showProblemRows: () => setProblemFilter(new Set(problemRows.map((r) => r.key))),
		clearFilters: () => { setSearch(""); setOnlyIncomplete(false); setProblemFilter(null); },
	};
}
