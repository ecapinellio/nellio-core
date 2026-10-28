"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Plus, Search } from "lucide-react";
import { saveProducts } from "@/app/(app)/products/actions";
import type { SaveConflict } from "@/lib/products/catalog";
import {
	emptyRow,
	fillFromPaste,
	findDuplicates,
	hasProblems,
	isBlank,
	isDirty,
	normalizeProductName,
	rowFromProduct,
	rowIssues,
	toSavePayload,
	type CatalogProduct,
	type GridColumn,
	type GridRow,
} from "@/lib/products/grid";
import { UNIT_LABELS, isProductUnit, type ProductUnit } from "@/lib/products/units";
import { useLeaveGuard } from "@/hooks/use-leave-guard";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { CatalogRow, type RowHandlers } from "@/components/products/catalog-row";
import { PasteGuide } from "@/components/products/paste-guide";
import { ConflictDialog, type ConflictChoice } from "@/components/products/conflict-dialog";
import { ProductEditSheet } from "@/components/products/product-edit-sheet";

const LEAVE_WARNING = "Tienes cambios sin guardar en el catálogo. Si sales, se pierden. ¿Salir de todas formas?";
const COLUMN_LABELS: Record<GridColumn, string> = { name: "Nombre", price: "Precio", unit: "Unidad" };

interface Toast
{
	id: number;
	text: string;
	showProblems?: boolean;
}

interface UnitPrompt
{
	key: string;
	unit: ProductUnit;
	raw: string;
	count: number;
}

function initialRows(products: CatalogProduct[]): GridRow[]
{
	return [...products.map(rowFromProduct), emptyRow("new-0")];
}

/** The grid always ends in one blank row to type or paste into. */
function withTrailingRow(rows: GridRow[], newKey: () => string): GridRow[]
{
	const last = rows[rows.length - 1];
	return last && isBlank(last) ? rows : [...rows, emptyRow(newKey())];
}

/**
 * /products — the catalog grid (eng + design review, 2026-10-27).
 *
 *   rows[] (whole catalog + new rows) ──filters──▶ visible rows ──▶ CatalogRow (memo)
 *        │                                                  ▲
 *        │ paste / typing / unit pick / active toggle ──────┘
 *        ▼
 *   sticky bar ── Guardar ──▶ saveProducts() ──▶ saved → toast, server re-render resets rows
 *                                         └──▶ conflicts → ConflictDialog → resolve → save again
 */
export function CatalogManager({ products }: { products: CatalogProduct[] })
{
	const keyCounter = useRef(1);
	const newKey = useCallback(() => `new-${keyCounter.current++}`, []);

	const [rows, setRows] = useState(() => initialRows(products));
	const [search, setSearch] = useState("");
	const [onlyNoPrice, setOnlyNoPrice] = useState(false);
	const [showInactive, setShowInactive] = useState(false);
	// Rows that had problems when the filter was turned on — a snapshot, so a
	// row being fixed doesn't vanish (and drop focus) mid-typing.
	const [problemFilter, setProblemFilter] = useState<Set<string> | null>(null);
	const onlyProblems = problemFilter !== null;
	const [attempted, setAttempted] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [toast, setToast] = useState<Toast | null>(null);
	const [conflicts, setConflicts] = useState<SaveConflict[] | null>(null);
	const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
	const [guideOpen, setGuideOpen] = useState(products.length === 0);
	const [unitPrompt, setUnitPrompt] = useState<UnitPrompt | null>(null);
	const [editing, setEditing] = useState<GridRow | null>(null);

	// Fresh rows whenever the server sends a new catalog (after a save's
	// revalidatePath) — adjusted during render, not in an effect.
	const [shownFor, setShownFor] = useState(products);
	if (products !== shownFor)
	{
		setShownFor(products);
		setRows(initialRows(products));
		setAttempted(false);
		setSaving(false);
		setEditing(null);
		// The guide is for an empty catalog; once something is saved it's opt-in.
		if (products.length > 0)
		{
			setGuideOpen(false);
		}
	}

	const duplicates = useMemo(() => findDuplicates(rows), [rows]);
	const dirty = useMemo(() => rows.filter(isDirty), [rows]);
	const problemRows = useMemo(
		() => rows.filter((r) => duplicates.has(r.key) || Object.values(rowIssues(r)).some((i) => i?.kind === "error" || (attempted && i))),
		[rows, duplicates, attempted],
	);

	const savedCount = products.filter((p) => p.active).length;
	const noPriceCount = products.filter((p) => p.price_per_unit === null).length;
	const newCount = dirty.filter((r) => r.id === null).length;
	const editedCount = dirty.length - newCount;

	const visible = useMemo(() =>
	{
		const needle = normalizeProductName(search);
		return rows.filter((r) =>
		{
			if (isBlank(r))
			{
				return !onlyProblems && !onlyNoPrice && needle === "";
			}
			if (problemFilter)
			{
				return problemFilter.has(r.key);
			}
			if (needle && !normalizeProductName(r.name).includes(needle))
			{
				return false;
			}
			if (onlyNoPrice && !(r.original !== null && r.original.price === ""))
			{
				return false;
			}
			// A row deactivated in this session stays visible until saved.
			return r.active || showInactive || isDirty(r);
		});
	}, [rows, search, onlyNoPrice, showInactive, onlyProblems, problemFilter]);

	useLeaveGuard(dirty.length > 0, LEAVE_WARNING);

	// Handlers read the latest state through a ref so they stay stable and
	// memoized rows don't re-render on every keystroke elsewhere (D9).
	const latest = useRef({ rows, visible });
	useEffect(() =>
	{
		latest.current = { rows, visible };
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

	const handlers = useMemo<RowHandlers>(() => ({
		onChange: (key, patch) =>
		{
			setRows((prev) => withTrailingRow(prev.map((r) => (r.key === key ? { ...r, ...patch } : r)), newKey));
		},
		onPaste: (key, column, text) =>
		{
			const { rows: all, visible: shown } = latest.current;
			const start = shown.findIndex((r) => r.key === key);
			// Fill down the rows the user SEES (filters may hide some).
			const result = fillFromPaste(shown, start, column, text, newKey);
			if (!result)
			{
				return false;
			}
			const updated = new Map(result.rows.map((r) => [r.key, r]));
			const known = new Set(all.map((r) => r.key));
			const merged = all.map((r) => updated.get(r.key) ?? r).filter((r) => !(isBlank(r) && !updated.has(r.key)));
			const added = result.rows.filter((r) => !known.has(r.key));
			const next = withTrailingRow([...merged, ...added], newKey);
			setRows(next);

			// Paste summary (design D8 / 5A).
			const touched = result.rows.slice(start, start + result.filled);
			const dupes = findDuplicates(next);
			const nDup = touched.filter((r) => dupes.has(r.key)).length;
			const nPrice = touched.filter((r) => rowIssues(r).price?.kind === "error").length;
			const nUnit = touched.filter((r) => r.unitRaw).length;
			const parts = [`Pegaste ${plural(result.filled, "fila", "filas")} en ${COLUMN_LABELS[column]}`];
			if (nDup) parts.push(plural(nDup, "repetido", "repetidos"));
			if (nPrice) parts.push(plural(nPrice, "precio por revisar", "precios por revisar"));
			if (nUnit) parts.push(plural(nUnit, "unidad no reconocida", "unidades no reconocidas"));
			if (result.extraColumns) parts.push(result.extraColumns === 1 ? "se ignoró 1 columna extra" : `se ignoraron ${result.extraColumns} columnas extra`);
			showToast(parts.join(" · "), nDup + nPrice + nUnit > 0);
			return true;
		},
		onUnitPick: (key, unit) =>
		{
			const row = latest.current.rows.find((r) => r.key === key);
			const raw = row?.unitRaw;
			if (raw)
			{
				const same = latest.current.rows.filter((r) => r.key !== key && r.unitRaw?.toLowerCase() === raw.toLowerCase()).length;
				if (same > 0)
				{
					setUnitPrompt({ key, unit, raw, count: same });
					return;
				}
			}
			setRows((prev) => withTrailingRow(prev.map((r) => (r.key === key ? { ...r, unit, unitRaw: null } : r)), newKey));
		},
		onToggleActive: (key) =>
		{
			setRows((prev) => prev.map((r) => (r.key === key ? { ...r, active: !r.active } : r)));
		},
	}), [newKey, showToast]);

	function applyUnitPrompt(all: boolean)
	{
		if (!unitPrompt)
		{
			return;
		}
		const raw = unitPrompt.raw.toLowerCase();
		setRows((prev) => prev.map((r) =>
			r.key === unitPrompt.key || (all && r.unitRaw?.toLowerCase() === raw) ? { ...r, unit: unitPrompt.unit, unitRaw: null } : r));
		setUnitPrompt(null);
	}

	const save = useCallback(async (source: GridRow[]) =>
	{
		setAttempted(true);
		setSaveError(null);
		const dupes = findDuplicates(source);
		const blocked = source.filter((r) => !isBlank(r) && isDirty(r) && hasProblems(r, dupes));
		if (blocked.length > 0)
		{
			setProblemFilter(new Set(blocked.map((r) => r.key)));
			requestAnimationFrame(() => document.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
			return;
		}

		const payload = toSavePayload(source);
		if (payload.length === 0)
		{
			return;
		}

		setSaving(true);
		try
		{
			const result = await saveProducts(payload);
			if (result.status === "saved")
			{
				showToast(result.saved === 1 ? "1 producto guardado" : `${result.saved} productos guardados`);
				setProblemFilter(null);
				// saving stays true until the revalidated catalog arrives and resets the grid.
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
	}, [showToast]);

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
			const theirs = rowFromProduct({ ...c, price_per_unit: c.price_per_unit });
			// "theirs": take the saved version as-is (row becomes clean).
			// "mine": keep my values, but against the new updated_at so the re-save wins.
			return next[c.id] === "theirs" ? { ...theirs, key: r.key } : { ...r, updatedAt: c.updated_at, original: theirs.original };
		});
		setRows(resolved);
		setConflicts(null);
		void save(resolved);
	}

	function discard()
	{
		if (window.confirm(`¿Descartar ${dirty.length === 1 ? "1 cambio" : `${dirty.length} cambios`}?`))
		{
			setRows(initialRows(products));
			setAttempted(false);
			setProblemFilter(null);
			setSaveError(null);
		}
	}

	function saveFromSheet(row: GridRow)
	{
		const exists = rows.some((r) => r.key === row.key);
		const next = withTrailingRow(exists ? rows.map((r) => (r.key === row.key ? row : r)) : [...rows.filter((r) => !isBlank(r)), row], newKey);
		setRows(next);
		void save(next);
	}

	const sheetDuplicate = useCallback((name: string, key: string) =>
	{
		const norm = normalizeProductName(name);
		return norm && rows.some((r) => r.key !== key && !isBlank(r) && normalizeProductName(r.name) === norm) ? "Ya existe" : undefined;
	}, [rows]);

	const filtering = search !== "" || onlyNoPrice || onlyProblems;

	return (
		<div className="flex flex-col gap-5">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Productos</h1>
					<p className="text-sm text-muted-foreground">
						<span className="font-mono tabular-nums">{savedCount}</span> {savedCount === 1 ? "producto activo" : "productos activos"}
						{noPriceCount > 0 ? <> · <span className="font-mono tabular-nums">{noPriceCount}</span> sin precio</> : null}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{!guideOpen
						? <Button type="button" variant="link" size="sm" className="hidden md:inline-flex" onClick={() => setGuideOpen(true)}>¿Cómo pegar desde Excel?</Button>
						: null}
					<Button type="button" className="h-11 md:hidden" onClick={() => setEditing(emptyRow(newKey()))}>
						<Plus />
						Agregar producto
					</Button>
				</div>
			</header>

			{guideOpen ? <div className="hidden md:block"><PasteGuide onClose={() => setGuideOpen(false)} /></div> : null}

			<p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground md:hidden">
				Para cargar varios productos desde Excel, usa una computadora.
			</p>

			<div className="flex flex-wrap items-center gap-2">
				<div className="relative w-full sm:w-72">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Buscar producto…"
						aria-label="Buscar producto"
						className="h-11 w-full rounded-md border border-input bg-transparent pr-3 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:h-9"
					/>
				</div>
				{noPriceCount > 0
					? (
						<Button
							type="button"
							variant={onlyNoPrice ? "default" : "outline"}
							size="sm"
							aria-pressed={onlyNoPrice}
							onClick={() => setOnlyNoPrice((v) => !v)}
							className="h-11 md:h-8"
						>
							Sin precio · <span className="font-mono tabular-nums">{noPriceCount}</span>
						</Button>
					)
					: null}
				<label className="flex h-11 items-center gap-2 px-1 text-sm md:h-8">
					<input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="size-4 accent-primary" />
					Mostrar desactivados
				</label>
				{onlyProblems
					? <Button type="button" variant="ghost" size="sm" onClick={() => setProblemFilter(null)} className="h-11 md:h-8">Ver todos</Button>
					: null}
			</div>

			{/* Desktop / tablet: the editable grid. */}
			<div className="hidden md:block">
				<table className="w-full border-collapse">
					<thead>
						<tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
							<th className="w-4" aria-label="Cambios" />
							<th className="px-2 py-2 font-medium">Nombre</th>
							<th className="px-2 py-2 text-right font-medium">Precio $</th>
							<th className="px-2 py-2 font-medium">Unidad</th>
							<th className="px-1 py-2 font-medium">Estado</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((row, i) => (
							<CatalogRow
								key={row.key}
								row={row}
								index={i}
								duplicate={duplicates.get(row.key)}
								attempted={attempted}
								handlers={handlers}
							/>
						))}
					</tbody>
				</table>
				{filtering && visible.length === 0
					? <EmptyFilter search={search} onClear={() => { setSearch(""); setOnlyNoPrice(false); setProblemFilter(null); }} />
					: null}
			</div>

			{/* Phone: read the list, edit one at a time (design D11). */}
			<ul className="flex flex-col divide-y divide-border rounded-lg border border-border md:hidden">
				{visible.filter((r) => !isBlank(r)).map((row) => (
					<li key={row.key}>
						<button
							type="button"
							onClick={() => setEditing(row)}
							className={cn("flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left", !row.active && "text-muted-foreground")}
						>
							<span className="flex min-w-0 flex-col">
								<span className="truncate text-sm font-medium">{row.name}</span>
								<span className="font-mono text-sm tabular-nums">
									{row.price ? `$${row.price}` : <span className="font-sans text-status-pending">Sin precio</span>}
									{row.unit && isProductUnit(row.unit) ? <span className="font-sans text-muted-foreground"> · {UNIT_LABELS[row.unit]}</span> : null}
								</span>
							</span>
							{!row.active ? <StatusBadge label="Desactivado" color="var(--user-inactive)" /> : null}
						</button>
					</li>
				))}
				{visible.every(isBlank)
					? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{filtering ? "Ningún producto coincide." : "Todavía no hay productos."}</li>
					: null}
			</ul>

			{/* Sticky save bar — only while there are changes (design D4 / 1A). */}
			{dirty.length > 0
				? (
					<div className="sticky bottom-0 z-10 -mx-4 hidden border-t border-border bg-background px-4 py-3 shadow-sm md:-mx-6 md:block md:px-6">
						{saveError
							? (
								<Alert variant="destructive" className="mb-2">
									<AlertTriangle />
									<AlertDescription>{saveError}</AlertDescription>
								</Alert>
							)
							: null}
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="text-sm">
								{[newCount ? `${newCount} ${newCount === 1 ? "nuevo" : "nuevos"}` : null, editedCount ? `${editedCount} ${editedCount === 1 ? "editado" : "editados"}` : null].filter(Boolean).join(" · ")}
								{problemRows.length > 0
									? (
										<>
											{" · "}
											<button type="button" onClick={() => setProblemFilter(new Set(problemRows.map((r) => r.key)))} className="font-medium text-destructive underline-offset-4 hover:underline">
												{problemRows.length === 1 ? "1 con problemas" : `${problemRows.length} con problemas`}
											</button>
										</>
									)
									: null}
							</p>
							<div className="flex gap-2">
								<Button type="button" variant="ghost" onClick={discard} disabled={saving}>Descartar</Button>
								<Button type="button" onClick={() => void save(rows)} disabled={saving}>
									{saving ? <><Loader2 className="animate-spin" />Guardando…</> : `Guardar ${dirty.length}`}
								</Button>
							</div>
						</div>
					</div>
				)
				: null}

			{saveError && editing === null
				? (
					<Alert variant="destructive" className="md:hidden">
						<AlertTriangle />
						<AlertDescription>{saveError}</AlertDescription>
					</Alert>
				)
				: null}

			<div role="status" aria-live="polite" className="pointer-events-none fixed right-4 bottom-24 z-20 flex justify-end md:bottom-20">
				{toast
					? (
						<div key={toast.id} className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm shadow-md">
							<span>{toast.text}</span>
							{toast.showProblems
								? <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => { setProblemFilter(new Set(problemRows.map((r) => r.key))); setToast(null); }}>Ver</Button>
								: null}
						</div>
					)
					: null}
			</div>

			<ConflictDialog
				conflicts={conflicts}
				rows={rows}
				choices={choices}
				onChoose={(id, choice) => resolveConflicts({ ...choices, [id]: choice })}
				onChooseAll={(choice) => resolveConflicts(Object.fromEntries((conflicts ?? []).map((c) => [c.id, choice])))}
				onCancel={() => setConflicts(null)}
			/>

			<Dialog open={unitPrompt !== null} onOpenChange={(open) => { if (!open) setUnitPrompt(null); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							¿Usar {unitPrompt ? UNIT_LABELS[unitPrompt.unit] : ""} para todas las filas que dicen ‘{unitPrompt?.raw}’?
						</DialogTitle>
						<DialogDescription>
							Hay {unitPrompt?.count === 1 ? "1 fila más" : `${unitPrompt?.count} filas más`} con esa unidad.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => applyUnitPrompt(false)}>Solo esta</Button>
						<Button type="button" onClick={() => applyUnitPrompt(true)}>Sí, a todas</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<ProductEditSheet
				row={editing}
				duplicate={sheetDuplicate}
				saving={saving}
				onSave={saveFromSheet}
				onClose={() => setEditing(null)}
			/>
		</div>
	);
}

function plural(n: number, one: string, many: string): string
{
	return `${n} ${n === 1 ? one : many}`;
}

function EmptyFilter({ search, onClear }: { search: string; onClear: () => void })
{
	return (
		<div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
			<p>{search ? `Ningún producto coincide con ‘${search}’.` : "Ningún producto coincide con el filtro."}</p>
			<Button type="button" variant="outline" size="sm" onClick={onClear}>Limpiar búsqueda</Button>
		</div>
	);
}
