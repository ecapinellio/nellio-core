"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { rowIssues, type GridRow } from "@/lib/products/grid";
import { PRODUCT_UNITS, UNIT_LABELS, type ProductUnit } from "@/lib/products/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * Phone editing (design D11 / 8A): one product at a time, 44px controls,
 * no paste. Saves straight away — on a phone there's no grid to batch.
 */
export function ProductEditSheet({
	row,
	duplicate,
	saving,
	onSave,
	onClose,
}: {
	row: GridRow | null;
	duplicate: (name: string, key: string) => string | undefined;
	saving: boolean;
	onSave: (row: GridRow) => void;
	onClose: () => void;
})
{
	return (
		<Sheet open={row !== null} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
			<SheetContent side="bottom" className="max-h-[90vh] gap-0 overflow-y-auto">
				{row ? <EditForm key={row.key} row={row} duplicate={duplicate} saving={saving} onSave={onSave} /> : null}
			</SheetContent>
		</Sheet>
	);
}

function EditForm({
	row,
	duplicate,
	saving,
	onSave,
}: {
	row: GridRow;
	duplicate: (name: string, key: string) => string | undefined;
	saving: boolean;
	onSave: (row: GridRow) => void;
})
{
	const [draft, setDraft] = useState(row);
	const [attempted, setAttempted] = useState(false);
	const issues = rowIssues(draft);
	const dup = duplicate(draft.name, draft.key);
	const nameError = dup ?? (issues.name?.kind === "error" ? issues.name.message : issues.name ? "Falta el nombre" : null);
	const priceError = issues.price ? (issues.price.kind === "error" ? issues.price.message : "Falta el precio") : null;
	const unitError = issues.unit ? (issues.unit.kind === "error" ? issues.unit.message : "Elige una unidad") : null;
	const hasErrors = Boolean(nameError || priceError || unitError);

	function submit(e: React.FormEvent)
	{
		e.preventDefault();
		setAttempted(true);
		if (!hasErrors)
		{
			onSave(draft);
		}
	}

	return (
		<form onSubmit={submit} noValidate>
			<SheetHeader>
				<SheetTitle>{row.original ? "Editar producto" : "Agregar producto"}</SheetTitle>
				<SheetDescription className="sr-only">Nombre, precio, unidad y estado del producto.</SheetDescription>
			</SheetHeader>
			<div className="flex flex-col gap-4 px-4">
				<Field id="edit-name" label="Nombre" error={attempted || dup ? nameError : null}>
					<Input id="edit-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="h-11" />
				</Field>
				<Field id="edit-price" label="Precio $" error={attempted ? priceError : null}>
					<Input
						id="edit-price"
						inputMode="decimal"
						value={draft.price}
						onChange={(e) => setDraft({ ...draft, price: e.target.value })}
						className="h-11 font-mono tabular-nums"
					/>
				</Field>
				<Field id="edit-unit" label="Unidad" error={attempted ? unitError : null}>
					<Select value={draft.unit || ""} onValueChange={(v) => setDraft({ ...draft, unit: v as ProductUnit, unitRaw: null })}>
						<SelectTrigger id="edit-unit" className="h-11 w-full">
							<SelectValue placeholder="Elegir" />
						</SelectTrigger>
						<SelectContent>
							{PRODUCT_UNITS.map((u) => <SelectItem key={u} value={u}>{UNIT_LABELS[u]}</SelectItem>)}
						</SelectContent>
					</Select>
				</Field>
				{row.original
					? (
						<label className="flex h-11 items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={draft.active}
								onChange={(e) => setDraft({ ...draft, active: e.target.checked })}
								className="size-5 accent-primary"
							/>
							Activo (aparece al capturar pedidos)
						</label>
					)
					: null}
			</div>
			<SheetFooter>
				<Button type="submit" className="h-11" disabled={saving}>
					{saving ? <><Loader2 className="animate-spin" />Guardando…</> : "Guardar"}
				</Button>
			</SheetFooter>
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
