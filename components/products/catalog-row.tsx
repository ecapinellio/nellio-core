"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import { isBlank, isDirty, rowIssues, type CellIssue, type GridColumn, type GridRow } from "@/lib/products/grid";
import { PRODUCT_UNITS, UNIT_LABELS, type ProductUnit } from "@/lib/products/units";
import { StatusBadge } from "@/components/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RowHandlers
{
	onChange: (key: string, patch: Partial<Pick<GridRow, "name" | "price">>) => void;
	/** true when the paste was multi-line/multi-column and the grid handled it. */
	onPaste: (key: string, column: GridColumn, text: string) => boolean;
	onUnitPick: (key: string, unit: ProductUnit) => void;
	onToggleActive: (key: string) => void;
}

// Inputs look like spreadsheet cells until hovered/focused (design spec).
const CELL_INPUT =
	"h-9 w-full rounded-sm border border-transparent bg-transparent px-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One grid row. memo + stable handlers (eng review D9): typing re-renders
 * only the row that changed, so 500+ rows stay smooth.
 */
export const CatalogRow = memo(function CatalogRow({
	row,
	index,
	duplicate,
	attempted,
	handlers,
}: {
	row: GridRow;
	/** Position among visible rows — Enter moves to index + 1. */
	index: number;
	duplicate: string | undefined;
	/** After a save attempt, "falta" cells turn red (design D6). */
	attempted: boolean;
	handlers: RowHandlers;
})
{
	const issues = rowIssues(row);
	const nameIssue: CellIssue | undefined = duplicate ? { kind: "error", message: duplicate } : issues.name;
	const label = row.name.trim() || `fila ${index + 1}`;
	const quickAddedNoPrice = row.original !== null && row.original.price === "" && row.price === "";
	const inactive = !row.active;

	function focusBelow(column: GridColumn)
	{
		document.querySelector<HTMLElement>(`[data-cell="${index + 1}-${column}"]`)?.focus();
	}

	function onKeyDown(e: React.KeyboardEvent, column: GridColumn)
	{
		if (e.key === "Enter")
		{
			e.preventDefault();
			focusBelow(column);
		}
	}

	function onPaste(e: React.ClipboardEvent, column: GridColumn)
	{
		if (handlers.onPaste(row.key, column, e.clipboardData.getData("text")))
		{
			e.preventDefault();
		}
	}

	return (
		<tr className={cn("border-b border-border align-top", inactive && "text-muted-foreground")}>
			<td className="w-4 pt-3.5 pl-1">
				{isDirty(row)
					? <span className="block size-1.5 rounded-full bg-primary"><span className="sr-only">Cambio sin guardar</span></span>
					: null}
			</td>
			<td className="py-1 pr-2">
				<input
					data-cell={`${index}-name`}
					value={row.name}
					placeholder={isBlank(row) ? "Escribe o pega desde Excel…" : undefined}
					aria-label={`Nombre de ${label}`}
					aria-invalid={cellInvalid(nameIssue, attempted) || undefined}
					aria-describedby={nameIssue ? `${row.key}-name-msg` : undefined}
					onChange={(e) => handlers.onChange(row.key, { name: e.target.value })}
					onPaste={(e) => onPaste(e, "name")}
					onKeyDown={(e) => onKeyDown(e, "name")}
					className={cn(CELL_INPUT, cellTone(nameIssue, attempted))}
				/>
				<CellMessage id={`${row.key}-name-msg`} issue={nameIssue} attempted={attempted} />
			</td>
			<td className="w-36 py-1 pr-2">
				<input
					data-cell={`${index}-price`}
					value={row.price}
					inputMode="decimal"
					placeholder={issues.price?.kind === "missing" ? "falta" : undefined}
					aria-label={`Precio de ${label}`}
					aria-invalid={cellInvalid(issues.price, attempted) || undefined}
					aria-describedby={issues.price ? `${row.key}-price-msg` : undefined}
					onChange={(e) => handlers.onChange(row.key, { price: e.target.value })}
					onPaste={(e) => onPaste(e, "price")}
					onKeyDown={(e) => onKeyDown(e, "price")}
					className={cn(CELL_INPUT, "text-right font-mono tabular-nums", cellTone(issues.price, attempted))}
				/>
				{quickAddedNoPrice
					? (
						<span className="mt-0.5 inline-block rounded-sm bg-status-pending-tint px-1.5 text-[11px] font-medium text-status-pending">
							Sin precio
						</span>
					)
					: <CellMessage id={`${row.key}-price-msg`} issue={issues.price} attempted={attempted} />}
			</td>
			<td className="w-44 py-1 pr-2" onPaste={(e) => onPaste(e, "unit")}>
				<Select value={row.unit || ""} onValueChange={(v) => handlers.onUnitPick(row.key, v as ProductUnit)}>
					<SelectTrigger
						data-cell={`${index}-unit`}
						aria-label={`Unidad de ${label}`}
						aria-invalid={cellInvalid(issues.unit, attempted) || undefined}
						aria-describedby={issues.unit ? `${row.key}-unit-msg` : undefined}
						onKeyDown={(e) => onKeyDown(e, "unit")}
						className={cn("h-9 w-full border-transparent hover:border-input", cellTone(issues.unit, attempted))}
					>
						<SelectValue placeholder={row.unitRaw ? `${row.unitRaw}` : issues.unit?.kind === "missing" ? "falta" : "Elegir"} />
					</SelectTrigger>
					<SelectContent>
						{PRODUCT_UNITS.map((u) => <SelectItem key={u} value={u}>{UNIT_LABELS[u]}</SelectItem>)}
					</SelectContent>
				</Select>
				<CellMessage id={`${row.key}-unit-msg`} issue={issues.unit} attempted={attempted} />
			</td>
			<td className="w-36 py-1">
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
							<StatusBadge
								label={row.active ? "Activo" : "Desactivado"}
								color={row.active ? "var(--user-active)" : "var(--user-inactive)"}
							/>
						</button>
					)
					: null}
			</td>
		</tr>
	);
});

function cellInvalid(issue: CellIssue | undefined, attempted: boolean): boolean
{
	return issue?.kind === "error" || (issue?.kind === "missing" && attempted);
}

function cellTone(issue: CellIssue | undefined, attempted: boolean): string
{
	return cellInvalid(issue, attempted) ? "border-destructive bg-destructive/5 hover:border-destructive" : "";
}

function CellMessage({ id, issue, attempted }: { id: string; issue: CellIssue | undefined; attempted: boolean })
{
	if (!issue)
	{
		return null;
	}
	if (issue.kind === "missing")
	{
		return attempted ? <p id={id} className="mt-0.5 px-2 text-[11px] font-medium text-destructive">Falta</p> : null;
	}
	return <p id={id} className="mt-0.5 px-2 text-[11px] font-medium text-destructive">{issue.message}</p>;
}
