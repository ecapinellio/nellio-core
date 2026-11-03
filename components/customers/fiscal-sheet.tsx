"use client";

import { useState } from "react";
import { FISCAL_FIELDS, type CustomerRow } from "@/lib/customers/grid";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FormPanel, FormPanelFooter } from "@/components/form-panel";
import { FiscalFields, firstFiscalError, type FiscalValues } from "@/components/customers/fiscal-fields";

/**
 * Desktop side panel for the fiscal fields (customers design D3/D6). It
 * never saves on its own: "Aplicar" puts the values in the row (teal dot)
 * and the bottom bar's Guardar saves them with everything else — one save,
 * so you can't conflict with your own edit.
 */
export function FiscalSheet({
	row,
	onApply,
	onClose,
}: {
	row: CustomerRow | null;
	onApply: (key: string, values: FiscalValues) => void;
	onClose: () => void;
})
{
	return (
		<FormPanel open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
			{row ? <FiscalForm key={row.key} row={row} onApply={onApply} /> : null}
		</FormPanel>
	);
}

function FiscalForm({ row, onApply }: { row: CustomerRow; onApply: (key: string, values: FiscalValues) => void })
{
	const [values, setValues] = useState<FiscalValues>(() =>
		Object.fromEntries(FISCAL_FIELDS.map((f) => [f, row[f]])) as FiscalValues);

	return (
		<form onSubmit={(e) => { e.preventDefault(); onApply(row.key, values); }} noValidate className="flex min-h-full flex-col">
			<SheetHeader>
				<SheetTitle>{row.name || "Cliente nuevo"}</SheetTitle>
				<SheetDescription>Datos fiscales para la factura electrónica. Todos son opcionales por ahora.</SheetDescription>
			</SheetHeader>
			<div className="px-4">
				<FiscalFields
					values={values}
					onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
					idPrefix="fiscal"
					focusField={firstFiscalError(values)}
				/>
			</div>
			<FormPanelFooter>
				<Button type="submit">Aplicar</Button>
				<p className="text-center text-xs text-muted-foreground">Se guarda con Guardar abajo.</p>
			</FormPanelFooter>
		</form>
	);
}
