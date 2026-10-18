import { forwardRef } from "react";
import type { ReactNode } from "react";
import type { OrderStatus } from "@/lib/order-math";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { cn } from "@/lib/utils";

interface KanbanColumnProps
{
	status: OrderStatus;
	count: number;
	/** True while a dragged card is hovering this column (@dnd-kit's useDroppable, wired in OrdersKanban/S3f) — drives the dashed drop-target border. */
	isOver?: boolean;
	children: ReactNode;
}

/**
 * Generic, rendered 4x (one per OrderStatus) by OrdersKanban. Stays free of
 * any @dnd-kit import — the drop-target ref and isOver state are supplied
 * by the caller (useDroppable lives in S3f), same split as OrderCard/S3d.
 *
 * Column body has its own independent vertical scroll (design review,
 * Decision 1) so one long column never pushes the others out of view.
 */
export const KanbanColumn = forwardRef<HTMLDivElement, KanbanColumnProps>(function KanbanColumn(
	{ status, count, isOver, children },
	ref,
)
{
	return (
		<div className="flex h-full w-[300px] shrink-0 flex-col rounded-lg border border-border bg-muted/30">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
				<OrderStatusBadge status={status} />
				<span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
			</div>

			<div
				ref={ref}
				className={cn(
					"flex flex-1 flex-col gap-2 overflow-y-auto border-2 border-transparent p-3",
					isOver ? "border-dashed border-primary" : null,
				)}
			>
				{count === 0
					? <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Sin pedidos</p>
					: children}
			</div>
		</div>
	);
});
