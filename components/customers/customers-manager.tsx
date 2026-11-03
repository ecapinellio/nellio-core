"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";
import { saveCustomers } from "@/app/(app)/customers/actions";
import type { CustomerConflict } from "@/lib/customers/catalog";
import { normalizeName, rebaseChangedFields } from "@/lib/grid/core";
import { normalizeTaxId } from "@/lib/customers/parse";
import {
	buildCustomerContext,
	customerGridModel,
	customerIssues,
	emptyCustomerRow,
	isBlankCustomer,
	isNameOnly,
	rowFromCustomer,
	TEXT_FIELDS,
	toCustomerPayload,
	type CustomerColumn,
	type CustomerContext,
	type CustomerRecord,
	type CustomerRow,
} from "@/lib/customers/grid";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useEditableGrid } from "@/components/grid/use-editable-grid";
import { EmptyFilter, GridToastView, GridToolbar, PasteRenameDialog, SaveBar } from "@/components/grid/grid-chrome";
import { ConflictDialog } from "@/components/grid/conflict-dialog";
import { PasteGuide } from "@/components/grid/paste-guide";
import { CustomerRowView, type CustomerRowHandlers } from "@/components/customers/customer-row";
import { FiscalPanel } from "@/components/customers/fiscal-panel";
import { CustomerEditPanel } from "@/components/customers/customer-edit-panel";

const NOUNS = { one: "cliente", many: "clientes" };
const COLUMN_LABELS: Record<CustomerColumn, string> = { name: "Nombre", phone: "Teléfono", address: "Dirección", tax_id: "NIT" };
const HEADER_ALIASES = ["Cliente", "Clientes", "Razón social", "Tel", "Tel.", "Celular", "Teléfonos", "Direccion", "DUI", "NIT/DUI", "NIT / DUI", "NIT o DUI"];
const LEAVE_WARNING = "Tienes cambios sin guardar en clientes. Si sales, se pierden. ¿Salir de todas formas?";

const fromConflict = (c: CustomerConflict) => rowFromCustomer(c);
const REBASE_FIELDS = [...TEXT_FIELDS, "active"] as const;
const rebaseOnto = (mine: CustomerRow, saved: CustomerRow): CustomerRow => rebaseChangedFields(mine, saved, REBASE_FIELDS);

// The NIT index only changes when some NIT does — returning the same object
// otherwise keeps the memoized rows from all re-rendering on each keystroke.
let lastSignature = "";
let lastContext: CustomerContext = { byTaxId: new Map() };
function contextFor(rows: CustomerRow[]): CustomerContext
{
	// Only rows with a NIT are in the index (and only their key/name/NIT are read).
	const signature = rows.filter((r) => r.tax_id.trim() !== "").map((r) => `${r.key}\u0000${r.tax_id}\u0000${r.name}`).join("\u0001");
	if (signature !== lastSignature)
	{
		lastSignature = signature;
		lastContext = buildCustomerContext(rows);
	}
	return lastContext;
}

function pasteSummary(touched: CustomerRow[], info: { ctx: CustomerContext })
{
	const issues = touched.map((r) => customerIssues(r, info.ctx));
	const sharedNit = issues.filter((i) => i.tax_id?.kind === "warning").length;
	const badNit = issues.filter((i) => i.tax_id?.kind === "error").length;
	const phones = issues.filter((i) => i.phone?.kind === "warning").length;
	const padded = touched.filter((r) => r.taxIdPadded).length;
	const parts: string[] = [];
	if (badNit) parts.push(badNit === 1 ? "1 NIT inválido" : `${badNit} NIT inválidos`);
	if (sharedNit) parts.push(sharedNit === 1 ? "1 NIT compartido" : `${sharedNit} NIT compartidos`);
	if (phones) parts.push(phones === 1 ? "1 teléfono por revisar" : `${phones} teléfonos por revisar`);
	if (padded) parts.push(padded === 1 ? "se agregó un 0 a 1 NIT" : `se agregó un 0 a ${padded} NIT`);
	return { parts, attention: badNit + sharedNit + phones };
}

function describe(name: string, phone: string | null, taxId: string | null, nrc: string | null, active: boolean): string
{
	return [name, phone || "sin teléfono", taxId ? `NIT ${taxId}` : "sin NIT", nrc ? `NRC ${nrc}` : null, active ? null : "desactivado"].filter(Boolean).join(" · ");
}

/**
 * /customers — the businesses that order from the tenant (customers eng +
 * design review, 2026-11-01). Same grid as /products (components/grid/);
 * this adds the customer columns, the fiscal panel, NIT/phone warnings,
 * reactivating a deactivated duplicate, and the phone list.
 */
export function CustomersManager({ customers }: { customers: CustomerRecord[] })
{
	const [guideOpen, setGuideOpen] = useState(customers.length === 0);
	const [editing, setEditing] = useState<CustomerRow | null>(null);
	const [fiscalKey, setFiscalKey] = useState<string | null>(null);

	const grid = useEditableGrid({
		model: customerGridModel,
		records: customers,
		fromRecord: rowFromCustomer,
		fromConflict,
		rebaseOnto,
		buildContext: contextFor,
		issuesOf: customerIssues,
		nameColumn: "name",
		columnLabels: COLUMN_LABELS,
		headerAliases: HEADER_ALIASES,
		pasteSummary,
		incomplete: isNameOnly,
		toPayload: toCustomerPayload,
		save: saveCustomers,
		nouns: NOUNS,
		leaveWarning: LEAVE_WARNING,
		onReset: (next) =>
		{
			setEditing(null);
			setFiscalKey(null);
			if (next.length > 0)
			{
				setGuideOpen(false);
			}
		},
	});
	const { rows, setRows, visible, saving, saveError, attempted, dirty, ctx, latest, updateRow, requestPaste } = grid;

	// A new name matching a deactivated customer says so and offers to
	// reactivate it instead (design D7).
	const duplicates = useMemo(() =>
	{
		const messages = new Map(grid.duplicates);
		for (const key of messages.keys())
		{
			const row = rows.find((r) => r.key === key);
			const inactive = row && rows.find((r) => r.key !== key && r.original !== null && !r.original.active && normalizeName(r.name) === normalizeName(row.name));
			if (inactive)
			{
				messages.set(key, `Existe desactivado: ${inactive.name}`);
			}
		}
		return messages;
	}, [grid.duplicates, rows]);

	const activeCount = customers.filter((c) => c.active).length;
	const nameOnlyCount = customers.filter((c) => c.active && !c.phone && !c.address && !c.tax_id).length;

	const handlers = useMemo<CustomerRowHandlers>(() => ({
		onChange: (key, patch) => updateRow(key, (r) => ({ ...r, ...patch, ...(patch.tax_id !== undefined ? { taxIdPadded: false } : {}) })),
		onPaste: requestPaste,
		onToggleActive: (key) => updateRow(key, (r) => ({ ...r, active: !r.active })),
		onOpenFiscal: (key) => setFiscalKey(key),
		onReactivateDuplicate: (key) =>
		{
			const all = latest.current.rows;
			const dup = all.find((r) => r.key === key);
			if (!dup)
			{
				return;
			}
			// Whatever was typed in the new row (phone, NIT…) moves to the
			// reactivated one instead of being dropped with the row.
			const typed = Object.fromEntries(TEXT_FIELDS.filter((f) => f !== "name" && dup[f].trim() !== "").map((f) => [f, dup[f]]));
			const norm = normalizeName(dup.name);
			setRows(all
				.filter((r) => r.key !== key)
				.map((r) => (r.original !== null && !r.original.active && normalizeName(r.name) === norm
					? { ...r, ...typed, taxIdPadded: dup.taxIdPadded && "tax_id" in typed, active: true }
					: r)));
		},
	}), [updateRow, requestPaste, latest, setRows]);

	const fiscalRow = fiscalKey ? rows.find((r) => r.key === fiscalKey) ?? null : null;

	return (
		<div className="flex flex-col gap-5">
			<header className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-xl font-semibold tracking-tight">Clientes</h1>
					<p className="text-sm text-muted-foreground">
						<span className="font-mono tabular-nums">{activeCount}</span> {activeCount === 1 ? "cliente activo" : "clientes activos"}
						{nameOnlyCount > 0 ? <> · <span className="font-mono tabular-nums">{nameOnlyCount}</span> solo nombre</> : null}
					</p>
				</div>
				<div className="flex items-center gap-2">
					{!guideOpen
						? <Button type="button" variant="link" size="sm" className="hidden md:inline-flex" onClick={() => setGuideOpen(true)}>¿Cómo pegar desde Excel?</Button>
						: null}
					<Button type="button" className="h-11 md:hidden" onClick={() => setEditing(emptyCustomerRow(grid.newKey()))}>
						<Plus />
						Agregar cliente
					</Button>
				</div>
			</header>

			{guideOpen
				? (
					<div className="hidden md:block">
						<PasteGuide
							title="Carga tus clientes desde Excel"
							steps={[
								<>En Excel, selecciona y copia la columna de <strong>nombres</strong> (una fila por cliente o sucursal).</>,
								<>Haz clic en la primera celda de <strong>Nombre</strong> y pega (Ctrl+V).</>,
								<>Repite con <strong>Teléfono</strong>, <strong>Dirección</strong> y <strong>NIT</strong>, o copia las 4 columnas juntas.</>,
							]}
							example={[
								{ header: "Nombre", value: "Super Selectos Escalón", width: "10rem" },
								{ header: "Teléfono", value: "2222-3333", numeric: true, width: "5.5rem" },
								{ header: "Dirección", value: "Paseo Escalón", width: "7rem" },
								{ header: "NIT", value: "0614-010190-101-3", numeric: true, width: "9rem" },
							]}
							footnote="Si en Excel tus NIT o teléfonos son números, se pueden perder ceros al inicio: dale formato de texto a esas columnas. Los datos fiscales (razón social, NRC, giro) se completan después en la columna Datos fiscales."
							onClose={() => setGuideOpen(false)}
						/>
					</div>
				)
				: null}

			<p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground md:hidden">
				Para cargar varios clientes desde Excel, usa una computadora.
			</p>

			<GridToolbar
				search={grid.search}
				onSearch={grid.setSearch}
				searchLabel="Buscar cliente, teléfono o NIT"
				incomplete={{ label: "Solo nombre", count: nameOnlyCount, on: grid.onlyIncomplete, toggle: () => grid.setOnlyIncomplete((v) => !v) }}
				showInactive={grid.showInactive}
				onShowInactive={grid.setShowInactive}
				onlyProblems={grid.onlyProblems}
				onShowAll={() => grid.setProblemFilter(null)}
			/>

			<fieldset disabled={saving} aria-busy={saving} className="m-0 hidden min-w-0 border-0 p-0 md:block">
				<div className="overflow-x-auto">
					<table className="w-full min-w-190 table-fixed border-collapse">
						<thead>
							<tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
								<th className="w-4" aria-label="Cambios" />
								<th className="px-2 py-2 font-medium">Nombre</th>
								<th className="w-36 px-2 py-2 font-medium">Teléfono</th>
								<th className="px-2 py-2 font-medium">Dirección</th>
								<th className="w-44 px-2 py-2 font-medium">NIT / DUI</th>
								<th className="w-28 px-1 py-2 font-medium">Estado</th>
								<th className="w-28 px-1 py-2 font-medium">Datos fiscales</th>
							</tr>
						</thead>
						<tbody>
							{visible.map((row, i) => (
								<CustomerRowView
									key={row.key}
									row={row}
									index={i}
									duplicate={duplicates.get(row.key)}
									ctx={ctx}
									attempted={attempted}
									handlers={handlers}
								/>
							))}
						</tbody>
					</table>
				</div>
				{grid.filtering && visible.length === 0
					? <EmptyFilter search={grid.search} noun="cliente" onClear={grid.clearFilters} />
					: null}
			</fieldset>

			{/* Phone: list, call with one tap, edit one at a time (design D8). */}
			<ul className="flex flex-col divide-y divide-border rounded-lg border border-border md:hidden">
				{visible.filter((r) => !isBlankCustomer(r)).map((row) => (
					<li key={row.key} className={cn("flex items-start justify-between gap-3 px-3 py-2", !row.active && "text-muted-foreground")}>
						<button type="button" onClick={() => setEditing(row)} className="flex min-h-11 min-w-0 flex-1 flex-col text-left">
							<span className="truncate text-sm font-medium">{row.name}</span>
							{row.address ? <span className="line-clamp-2 text-xs text-muted-foreground">{row.address}</span> : null}
							{isNameOnly(row) ? <span className="text-xs text-status-pending">Solo nombre</span> : null}
						</button>
						<span className="flex shrink-0 flex-col items-end gap-1">
							{row.phone
								? <a href={`tel:${row.phone.replace(/[^\d+]/g, "")}`} className="flex min-h-11 items-center font-mono text-sm tabular-nums text-primary">{row.phone}</a>
								: null}
							{!row.active ? <StatusBadge label="Desactivado" color="var(--user-inactive)" /> : null}
						</span>
					</li>
				))}
				{visible.every(isBlankCustomer)
					? <li className="px-3 py-6 text-center text-sm text-muted-foreground">{grid.filtering ? "Ningún cliente coincide." : "Todavía no hay clientes."}</li>
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
						onSave={() => void grid.save(rows)}
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
				describeTheirs={(c) => describe(c.name, c.phone, c.tax_id, c.nrc, c.active)}
				describeMine={(id) =>
				{
					const mine = rows.find((r) => r.id === id);
					return mine ? describe(mine.name, mine.phone, mine.tax_id ? (normalizeTaxId(mine.tax_id)?.value ?? mine.tax_id) : null, mine.nrc, mine.active) : null;
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

			<FiscalPanel
				row={fiscalRow}
				onApply={(key, values) =>
				{
					updateRow(key, (r) => ({ ...r, ...values }));
					setFiscalKey(null);
				}}
				onClose={() => setFiscalKey(null)}
			/>

			<CustomerEditPanel
				row={editing}
				allRows={rows}
				duplicate={grid.nameTaken}
				saving={saving}
				error={saveError}
				onSave={grid.saveRow}
				onClose={() => setEditing(null)}
			/>
		</div>
	);
}
