"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { saveProducts } from "@/app/(app)/products/actions";
import type { SaveConflict } from "@/lib/products/catalog";
import {
	emptyRow,
	isBlank,
	productGridModel,
	rowFromProduct,
	rowIssues,
	toSavePayload,
	type CatalogProduct,
	type GridColumn,
	type GridRow,
} from "@/lib/products/grid";
import { UNIT_LABELS, isProductUnit, type ProductUnit } from "@/lib/products/units";
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
import { useEditableGrid } from "@/components/grid/use-editable-grid";
import { EmptyFilter, GridToastView, GridToolbar, PasteRenameDialog, SaveBar } from "@/components/grid/grid-chrome";
import { ConflictDialog } from "@/components/grid/conflict-dialog";
import { CatalogRow, type RowHandlers } from "@/components/products/catalog-row";
import { PasteGuide } from "@/components/products/paste-guide";
import { ProductEditSheet } from "@/components/products/product-edit-sheet";

const NOUNS = { one: "producto", many: "productos" };
const COLUMN_LABELS: Record<GridColumn, string> = { name: "Nombre", price: "Precio", unit: "Unidad" };
const LEAVE_WARNING = "Tienes cambios sin guardar en el catálogo. Si sales, se pierden. ¿Salir de todas formas?";

interface UnitPrompt
{
	key: string;
	unit: ProductUnit;
	raw: string;
	count: number;
}

const fromConflict = (c: SaveConflict) => rowFromProduct(c);
const rebaseOnto = (mine: GridRow, saved: GridRow): GridRow => ({ ...mine, updatedAt: saved.updatedAt, original: saved.original });
const noContext = () => undefined;
const issuesOf = (row: GridRow) => rowIssues(row);
const isNoPrice = (row: GridRow) => row.original !== null && row.original.price === "";

function pasteSummary(touched: GridRow[])
{
	const nPrice = touched.filter((r) => rowIssues(r).price?.kind === "error").length;
	const nUnit = touched.filter((r) => r.unitRaw).length;
	const parts: string[] = [];
	if (nPrice) parts.push(nPrice === 1 ? "1 precio por revisar" : `${nPrice} precios por revisar`);
	if (nUnit) parts.push(nUnit === 1 ? "1 unidad no reconocida" : `${nUnit} unidades no reconocidas`);
	return { parts, attention: nPrice + nUnit };
}

function describe(name: string, price: string, unit: string | null, active: boolean): string
{
	const unitLabel = unit && isProductUnit(unit) ? UNIT_LABELS[unit] : "sin unidad";
	const priceText = price ? `$${price}` : "sin precio";
	return `${name} · ${priceText} · ${unitLabel}${active ? "" : " · desactivado"}`;
}

/**
 * /products — the catalog grid (eng + design review, 2026-10-27). State and
 * the shared grid chrome live in components/grid/; this adds what's
 * product-specific: price/unit cells, the unknown-unit prompt, the empty
 * catalog guide and the phone list.
 */
export function CatalogManager({ products }: { products: CatalogProduct[] })
{
	const [guideOpen, setGuideOpen] = useState(products.length === 0);
	const [unitPrompt, setUnitPrompt] = useState<UnitPrompt | null>(null);
	const [editing, setEditing] = useState<GridRow | null>(null);

	const grid = useEditableGrid({
		model: productGridModel,
		records: products,
		fromRecord: rowFromProduct,
		fromConflict,
		rebaseOnto,
		buildContext: noContext,
		issuesOf,
		nameColumn: "name",
		columnLabels: COLUMN_LABELS,
		pasteSummary,
		incomplete: isNoPrice,
		toPayload: toSavePayload,
		save: saveProducts,
		nouns: NOUNS,
		leaveWarning: LEAVE_WARNING,
		onReset: (next) =>
		{
			setEditing(null);
			// The guide is for an empty catalog; once something is saved it's opt-in.
			if (next.length > 0)
			{
				setGuideOpen(false);
			}
		},
	});
	const { visible, saving, saveError, attempted, duplicates, dirty, latest, updateRow, requestPaste } = grid;

	const savedCount = products.filter((p) => p.active).length;
	const noPriceCount = products.filter((p) => p.price_per_unit === null).length;

	const handlers = useMemo<RowHandlers>(() => ({
		onChange: (key, patch) => updateRow(key, (r) => ({ ...r, ...patch })),
		onPaste: requestPaste,
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
			updateRow(key, (r) => ({ ...r, unit, unitRaw: null }));
		},
		onToggleActive: (key) => updateRow(key, (r) => ({ ...r, active: !r.active })),
	}), [updateRow, requestPaste, latest]);

	function applyUnitPrompt(all: boolean)
	{
		if (!unitPrompt)
		{
			return;
		}
		const raw = unitPrompt.raw.toLowerCase();
		grid.setRows((prev) => prev.map((r) =>
			r.key === unitPrompt.key || (all && r.unitRaw?.toLowerCase() === raw) ? { ...r, unit: unitPrompt.unit, unitRaw: null } : r));
		setUnitPrompt(null);
	}

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
					<Button type="button" className="h-11 md:hidden" onClick={() => setEditing(emptyRow(grid.newKey()))}>
						<Plus />
						Agregar producto
					</Button>
				</div>
			</header>

			{guideOpen ? <div className="hidden md:block"><PasteGuide onClose={() => setGuideOpen(false)} /></div> : null}

			<p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground md:hidden">
				Para cargar varios productos desde Excel, usa una computadora.
			</p>

			<GridToolbar
				search={grid.search}
				onSearch={grid.setSearch}
				searchLabel="Buscar producto"
				incomplete={{ label: "Sin precio", count: noPriceCount, on: grid.onlyIncomplete, toggle: () => grid.setOnlyIncomplete((v) => !v) }}
				showInactive={grid.showInactive}
				onShowInactive={grid.setShowInactive}
				onlyProblems={grid.onlyProblems}
				onShowAll={() => grid.setProblemFilter(null)}
			/>

			{/* Desktop / tablet: the editable grid. Read-only while saving
			    (design D7): edits made mid-save would be wiped when the saved
			    catalog comes back. */}
			<fieldset disabled={saving} aria-busy={saving} className="m-0 hidden min-w-0 border-0 p-0 md:block">
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
				{grid.filtering && visible.length === 0
					? <EmptyFilter search={grid.search} noun="producto" onClear={grid.clearFilters} />
					: null}
			</fieldset>

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
					? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{grid.filtering ? "Ningún producto coincide." : "Todavía no hay productos."}</li>
					: null}
			</ul>

			{dirty.length > 0
				? (
					<SaveBar
						newCount={grid.newCount}
						editedCount={dirty.length - grid.newCount}
						problemCount={grid.problemRows.length}
						saving={saving}
						saveError={saveError}
						saveCount={dirty.length}
						onShowProblems={grid.showProblemRows}
						onDiscard={grid.discard}
						onSave={() => void grid.save(grid.rows)}
					/>
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

			<GridToastView toast={grid.toast} onShowProblems={() => { grid.showProblemRows(); grid.setToast(null); }} />

			<ConflictDialog
				conflicts={grid.conflicts}
				nouns={NOUNS}
				describeTheirs={(c) => describe(c.name, c.price_per_unit?.toFixed(2) ?? "", c.unit, c.active)}
				describeMine={(id) =>
				{
					const mine = grid.rows.find((r) => r.id === id);
					return mine ? describe(mine.name, mine.price, mine.unit, mine.active) : null;
				}}
				choices={grid.choices}
				onChoose={(id, choice) => grid.resolveConflicts({ ...grid.choices, [id]: choice })}
				onChooseAll={(choice) => grid.resolveConflicts(Object.fromEntries((grid.conflicts ?? []).map((c) => [c.id, choice])))}
				onCancel={() => grid.setConflicts(null)}
			/>

			<PasteRenameDialog
				prompt={grid.pastePrompt}
				nouns={NOUNS}
				onReplace={(p) => { grid.applyPaste(p.key, p.column, p.text); grid.setPastePrompt(null); }}
				onAddNew={(p) => { grid.applyPaste(null, p.column, p.text); grid.setPastePrompt(null); }}
				onCancel={() => grid.setPastePrompt(null)}
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
				duplicate={grid.nameTaken}
				saving={saving}
				error={saveError}
				onSave={grid.saveRow}
				onClose={() => setEditing(null)}
			/>
		</div>
	);
}
