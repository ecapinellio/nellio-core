import { AlertTriangle } from "lucide-react";
import { isProblemIssue, type CellIssue } from "@/lib/grid/core";

// Inputs look like spreadsheet cells until hovered/focused (catalog design spec).
export const CELL_INPUT =
	"h-9 w-full rounded-sm border border-transparent bg-transparent px-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function cellInvalid(issue: CellIssue | undefined, attempted: boolean): boolean
{
	return isProblemIssue(issue, attempted);
}

/** Red border + tint for errors only — warnings never tint the cell (customers design D4). */
export function cellTone(issue: CellIssue | undefined, attempted: boolean): string
{
	return cellInvalid(issue, attempted) ? "border-destructive bg-destructive/5 hover:border-destructive" : "";
}

/**
 * The reason under a cell: red for errors (and "Falta" after a save
 * attempt), ⚠ + amber text for warnings — never color alone.
 */
export function CellMessage({ id, issue, attempted }: { id: string; issue: CellIssue | undefined; attempted: boolean })
{
	if (!issue)
	{
		return null;
	}
	if (issue.kind === "missing")
	{
		return attempted ? <p id={id} className="mt-0.5 px-2 text-[11px] font-medium text-destructive">Falta</p> : null;
	}
	if (issue.kind === "warning")
	{
		return (
			<p id={id} className="mt-0.5 flex items-center gap-1 px-2 text-[11px] font-medium text-status-pending">
				<AlertTriangle className="size-3" aria-hidden />
				{issue.message}
			</p>
		);
	}
	return <p id={id} className="mt-0.5 px-2 text-[11px] font-medium text-destructive">{issue.message}</p>;
}

/** The teal "changed, not saved yet" dot in a row's left gutter. */
export function DirtyDot({ dirty }: { dirty: boolean })
{
	return (
		<td className="w-4 pt-3.5 pl-1">
			{dirty
				? <span className="block size-1.5 rounded-full bg-primary"><span className="sr-only">Cambio sin guardar</span></span>
				: null}
		</td>
	);
}
