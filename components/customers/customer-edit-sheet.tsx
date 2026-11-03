"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { buildCustomerContext, customerIssues, FISCAL_FIELDS, type CustomerRow } from "@/lib/customers/grid";
import { normalizeTaxId } from "@/lib/customers/parse";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FormPanel, FormPanelFooter } from "@/components/form-panel";
import { FiscalFields, firstFiscalError } from "@/components/customers/fiscal-fields";

/**
 * Phone editing (customers design D8): one sheet with "Contacto" and
 * "Datos fiscales" and its own Guardar — no panel stacked on a sheet.
 * In the shared FormPanel, like every form.
 */
export function CustomerEditSheet({
	row,
	allRows,
	duplicate,
	saving,
	error,
	onSave,
	onClose,
}: {
	row: CustomerRow | null;
	allRows: CustomerRow[];
	duplicate: (name: string, key: string) => string | undefined;
	saving: boolean;
	error: string | null;
	onSave: (row: CustomerRow) => void;
	onClose: () => void;
})
{
	return (
		<FormPanel open={row !== null} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
			{row ? <EditForm key={row.key} row={row} allRows={allRows} duplicate={duplicate} saving={saving} error={error} onSave={onSave} /> : null}
		</FormPanel>
	);
}

function EditForm({
	row,
	allRows,
	duplicate,
	saving,
	error,
	onSave,
}: {
	row: CustomerRow;
	allRows: CustomerRow[];
	duplicate: (name: string, key: string) => string | undefined;
	saving: boolean;
	error: string | null;
	onSave: (row: CustomerRow) => void;
})
{
	const [draft, setDraft] = useState(row);
	const [attempted, setAttempted] = useState(false);
	const issues = customerIssues(draft, buildCustomerContext(allRows.map((r) => (r.key === draft.key ? draft : r))));
	const dup = duplicate(draft.name, draft.key);
	const nameError = dup ?? (issues.name ? (issues.name.kind === "error" ? issues.name.message : "Falta el nombre") : null);
	const taxError = issues.tax_id?.kind === "error" ? issues.tax_id.message : null;
	const hasErrors = Boolean(nameError || taxError || firstFiscalError(draft) || issues.phone?.kind === "error" || issues.address?.kind === "error");

	function submit(e: React.FormEvent)
	{
		e.preventDefault();
		setAttempted(true);
		if (!hasErrors)
		{
			const tax = draft.tax_id.trim() === "" ? null : normalizeTaxId(draft.tax_id);
			onSave(tax ? { ...draft, tax_id: tax.value } : draft);
		}
	}

	const warning = (issue: typeof issues.phone) => (issue?.kind === "warning" ? <p className="text-xs font-medium text-status-pending">⚠ {issue.message}</p> : null);

	return (
		<form onSubmit={submit} noValidate className="flex min-h-full flex-col">
			<SheetHeader>
				<SheetTitle>{row.original ? "Editar cliente" : "Agregar cliente"}</SheetTitle>
				<SheetDescription className="sr-only">Contacto y datos fiscales del cliente.</SheetDescription>
			</SheetHeader>
			<div className="flex flex-col gap-6 px-4">
				<section className="flex flex-col gap-4" aria-labelledby="contact-title">
					<h3 id="contact-title" className="text-sm font-semibold">Contacto</h3>
					<Field id="c-name" label="Nombre" error={attempted || dup ? nameError : null}>
						<Input id="c-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-11" />
					</Field>
					<Field id="c-phone" label="Teléfono" error={issues.phone?.kind === "error" ? issues.phone.message : null}>
						<Input id="c-phone" inputMode="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} className="h-11 font-mono tabular-nums" />
						{warning(issues.phone)}
					</Field>
					<Field id="c-address" label="Dirección" error={issues.address?.kind === "error" ? issues.address.message : null}>
						<textarea
							id="c-address"
							rows={2}
							value={draft.address}
							onChange={(e) => setDraft({ ...draft, address: e.target.value })}
							className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
						/>
					</Field>
					<Field id="c-tax" label="NIT o DUI" error={attempted ? taxError : null}>
						<Input id="c-tax" inputMode="numeric" value={draft.tax_id} onChange={(e) => setDraft({ ...draft, tax_id: e.target.value })} className="h-11 font-mono tabular-nums" />
						{warning(issues.tax_id)}
					</Field>
					{row.original
						? (
							<label className="flex h-11 items-center gap-3 text-sm">
								<input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} className="size-5 accent-primary" />
								Activo (aparece al capturar pedidos)
							</label>
						)
						: null}
				</section>
				<section className="flex flex-col gap-4" aria-labelledby="fiscal-title">
					<h3 id="fiscal-title" className="text-sm font-semibold">Datos fiscales</h3>
					<FiscalFields
						values={Object.fromEntries(FISCAL_FIELDS.map((f) => [f, draft[f]])) as Record<(typeof FISCAL_FIELDS)[number], string>}
						onChange={(field, value) => setDraft({ ...draft, [field]: value })}
						idPrefix="c-fiscal"
					/>
				</section>
			</div>
			<FormPanelFooter>
				{error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
				<Button type="submit" className="h-11" disabled={saving}>
					{saving ? <><Loader2 className="animate-spin" />Guardando…</> : "Guardar"}
				</Button>
			</FormPanelFooter>
		</form>
	);
}

function Field({ id, label, error, children }: { id: string; label: string; error: string | null | undefined; children: React.ReactNode })
{
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
		</div>
	);
}
