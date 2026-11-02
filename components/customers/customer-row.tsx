"use client";

import { memo, useState } from "react";
import { cn } from "@/lib/utils";
import type { CellIssue } from "@/lib/grid/core";
import {
	FISCAL_FIELDS,
	customerIssues,
	fiscalFilled,
	isBlankCustomer,
	isDirtyCustomer,
	sharedTaxIdNote,
	type CustomerColumn,
	type CustomerContext,
	type CustomerRow,
} from "@/lib/customers/grid";
import { StatusBadge } from "@/components/status-badge";
import { CELL_INPUT, CellMessage, DirtyDot, cellInvalid, cellTone } from "@/components/grid/cells";

export interface CustomerRowHandlers
{
	onChange: (key: string, patch: Partial<Pick<CustomerRow, CustomerColumn>>) => void;
	/** true when the paste was multi-line/multi-column and the grid handled it. */
	onPaste: (key: string, column: CustomerColumn, text: string) => boolean;
	onToggleActive: (key: string) => void;
	onOpenFiscal: (key: string) => void;
	/** "Existe desactivado": reactivate the saved one and drop this new row. */
	onReactivateDuplicate: (key: string) => void;
}

/**
 * One customer row (memo + stable handlers, like the catalog). Grid columns
 * are Nombre | Teléfono | Dirección | NIT; the fiscal fields are behind the
 * last "Fiscal" button (customers design D3).
 */
export const CustomerRowView = memo(function CustomerRowView({
	row,
	index,
	duplicate,
	ctx,
	attempted,
	handlers,
}: {
	row: CustomerRow;
	index: number;
	/** "Ya existe" / "Repetido" / "Existe desactivado: …" */
	duplicate: string | undefined;
	ctx: CustomerContext;
	attempted: boolean;
	handlers: CustomerRowHandlers;
})
{
	const issues = customerIssues(row, ctx);
	const nameIssue: CellIssue | undefined = duplicate ? { kind: "error", message: duplicate } : issues.name;
	const label = row.name.trim() || `fila ${index + 1}`;
	const blank = isBlankCustomer(row);
	const [addressFocused, setAddressFocused] = useState(false);
	const taxNote = row.taxIdPadded && issues.tax_id === undefined ? "se agregó un 0" : sharedTaxIdNote(row, ctx);

	function focusBelow(column: CustomerColumn)
	{
		document.querySelector<HTMLElement>(`[data-cell="${index + 1}-${column}"]`)?.focus();
	}

	function onKeyDown(e: React.KeyboardEvent, column: CustomerColumn)
	{
		// Enter moves down, except inside the expanded address where it's a newline.
		if (e.key === "Enter" && !(column === "address" && e.shiftKey))
		{
			e.preventDefault();
			focusBelow(column);
		}
	}

	function onPaste(e: React.ClipboardEvent, column: CustomerColumn)
	{
		if (handlers.onPaste(row.key, column, e.clipboardData.getData("text")))
		{
			e.preventDefault();
		}
	}

	function input(column: Exclude<CustomerColumn, "address">, extra: string, placeholder?: string)
	{
		const issue = column === "name" ? nameIssue : issues[column];
		return (
			<input
				data-cell={`${index}-${column}`}
				value={row[column]}
				placeholder={placeholder}
				aria-label={`${COLUMN_ARIA[column]} de ${label}`}
				aria-invalid={cellInvalid(issue, attempted) || undefined}
				aria-describedby={issue ? `${row.key}-${column}-msg` : undefined}
				onChange={(e) => handlers.onChange(row.key, { [column]: e.target.value })}
				onPaste={(e) => onPaste(e, column)}
				onKeyDown={(e) => onKeyDown(e, column)}
				className={cn(CELL_INPUT, extra, cellTone(issue, attempted))}
			/>
		);
	}

	const fiscalCount = fiscalFilled(row);

	return (
		<tr className={cn("border-b border-border align-top", !row.active && "text-muted-foreground")}>
			<DirtyDot dirty={isDirtyCustomer(row)} />
			<td className="py-1 pr-2">
				{input("name", "", blank ? "Escribe o pega desde Excel…" : undefined)}
				<CellMessage id={`${row.key}-name-msg`} issue={nameIssue} attempted={attempted} />
				{duplicate?.startsWith("Existe desactivado")
					? (
						<button type="button" onClick={() => handlers.onReactivateDuplicate(row.key)} className="mt-0.5 px-2 text-[11px] font-medium text-primary underline-offset-4 hover:underline">
							Reactivar el existente
						</button>
					)
					: null}
			</td>
			<td className="py-1 pr-2">
				{input("phone", "font-mono tabular-nums")}
				<CellMessage id={`${row.key}-phone-msg`} issue={issues.phone} attempted={attempted} />
			</td>
			<td className="py-1 pr-2">
				{/* One line with "…" until focused, then a 3-line box (design D7). */}
				<textarea
					data-cell={`${index}-address`}
					value={row.address}
					rows={addressFocused ? 3 : 1}
					title={row.address || undefined}
					aria-label={`Dirección de ${label}`}
					aria-invalid={cellInvalid(issues.address, attempted) || undefined}
					onFocus={() => setAddressFocused(true)}
					onBlur={() => setAddressFocused(false)}
					onChange={(e) => handlers.onChange(row.key, { address: e.target.value })}
					onPaste={(e) => onPaste(e, "address")}
					onKeyDown={(e) => onKeyDown(e, "address")}
					className={cn(CELL_INPUT, "block resize-none py-2", !addressFocused && "h-9 truncate overflow-hidden whitespace-nowrap", cellTone(issues.address, attempted))}
				/>
				<CellMessage id={`${row.key}-address-msg`} issue={issues.address} attempted={attempted} />
			</td>
			<td className="py-1 pr-2">
				{input("tax_id", "font-mono tabular-nums")}
				{issues.tax_id
					? <CellMessage id={`${row.key}-tax_id-msg`} issue={issues.tax_id} attempted={attempted} />
					: taxNote ? <p className="mt-0.5 px-2 text-[11px] text-muted-foreground">{taxNote}</p> : null}
			</td>
			<td className="py-1">
				{row.original !== null
					? (
						<button
							type="button"
							onClick={() => handlers.onToggleActive(row.key)}
							aria-pressed={row.active}
							aria-label={`${row.active ? "Desactivar" : "Activar"} ${label}`}
							title={row.active ? "Clic para desactivar" : "Clic para activar"}
							className="flex h-9 items-center rounded-sm px-1 hover:bg-muted"
						>
							<StatusBadge label={row.active ? "Activo" : "Desactivado"} color={row.active ? "var(--user-active)" : "var(--user-inactive)"} />
						</button>
					)
					: null}
			</td>
			<td className="py-1">
				{!blank
					? (
						<button
							type="button"
							onClick={() => handlers.onOpenFiscal(row.key)}
							aria-label={`Datos fiscales de ${label}${issues.fiscal && issues.fiscal.kind !== "missing" ? `: ${issues.fiscal.message}` : ""}`}
							className={cn(
								"flex h-9 max-w-full items-center truncate rounded-sm border px-2 text-xs font-medium",
								issues.fiscal
									? "border-destructive bg-destructive/5 text-destructive"
									: fiscalCount === FISCAL_FIELDS.length
										? "border-input text-status-delivered hover:bg-muted"
										: "border-input hover:bg-muted",
							)}
						>
							{issues.fiscal && issues.fiscal.kind !== "missing"
								? issues.fiscal.message
								: fiscalChipLabel(fiscalCount)}
						</button>
					)
					: null}
			</td>
		</tr>
	);
});

function fiscalChipLabel(filled: number): string
{
	if (filled === 0)
	{
		return "Agregar";
	}
	return filled === FISCAL_FIELDS.length ? "Completo" : `Faltan ${FISCAL_FIELDS.length - filled}`;
}

const COLUMN_ARIA: Record<CustomerColumn, string> = { name: "Nombre", phone: "Teléfono", address: "Dirección", tax_id: "NIT" };
