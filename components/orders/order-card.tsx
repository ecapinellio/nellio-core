import { forwardRef } from "react";
import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { GripVertical } from "lucide-react";
import type { KanbanOrder } from "@/lib/supabase/queries";
import { calculateOrderTotal } from "@/lib/order-math";
import { formatOrderTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface OrderCardProps
{
	order: KanbanOrder;
	showConfirmButton?: boolean;
	onConfirm?: () => void;
	/** Slice 4: click on the card body (not the grip handle, not Confirmar) opens the detail dialog. */
	onOpenDetail?: () => void;
	isDragging?: boolean;
	style?: CSSProperties;
	className?: string;
	/**
	 * @dnd-kit's attributes+listeners (useSortable), spread onto the drag
	 * handle only — NOT the whole card. The handle is a sibling of the
	 * Confirmar button, not an ancestor, so the drag sensor's pointerdown
	 * listener never sits between a tap and the button's own click: a
	 * card-root listener swallowed the click even with stopPropagation on
	 * the button itself, since dnd-kit's pointer capture suppresses the
	 * subsequent click after a real (non-synthetic) pointerdown/up pair.
	 */
	dragHandleProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

const MAX_VISIBLE_ITEMS = 3;

/**
 * Presentational only — drag wiring (ref/listeners/attributes from
 * @dnd-kit's useSortable) is spread in by OrdersKanban (S3f), not imported
 * here, so this component has no @dnd-kit dependency of its own.
 *
 * No hover-elevate treatment on the card (design review, Decision 7): a
 * card-wide hover-elevate would compete visually with the drag/Confirmar
 * affordances. Slice 4's click-to-open-detail trigger is a plain onClick
 * on the root, not a hover treatment.
 */
export const OrderCard = forwardRef<HTMLDivElement, OrderCardProps>(function OrderCard(
	{ order, showConfirmButton, onConfirm, onOpenDetail, isDragging, style, className, dragHandleProps },
	ref,
)
{
	const { total, unpricedCount } = calculateOrderTotal(
		order.items.map((item) => ({ quantity: item.quantity, priceAtOrder: item.priceAtOrder })),
	);
	const allUnpriced = order.items.length > 0 && unpricedCount === order.items.length;
	const visibleItems = order.items.slice(0, MAX_VISIBLE_ITEMS);
	const extraCount = order.items.length - visibleItems.length;

	return (
		<div
			ref={ref}
			style={style}
			onClick={onOpenDetail}
			className={cn(
				"flex flex-col gap-2 rounded-md border border-border bg-card p-3",
				isDragging ? "opacity-50 shadow-md" : "shadow-none",
				className,
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="font-mono text-xs text-muted-foreground">{order.id.slice(0, 8)}</span>
				<button
					type="button"
					aria-label="Arrastrar para mover"
					className="touch-none cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
					{...dragHandleProps}
					onClick={(e) => e.stopPropagation()}
				>
					<GripVertical className="size-4" />
				</button>
			</div>

			<p className="truncate text-sm font-semibold">{order.customerName}</p>

			{order.items.length > 0
				? (
					<div className="flex flex-col gap-0.5">
						{visibleItems.map((item, i) => (
							<p key={i} className="truncate text-xs text-muted-foreground">
								{item.quantity} × {item.productName}
							</p>
						))}
						{extraCount > 0 ? <p className="text-xs text-muted-foreground">+{extraCount} más</p> : null}
					</div>
				)
				: null}

			<div className="border-t border-border pt-2">
				{allUnpriced
					? <span className="text-sm italic text-muted-foreground">Sin precio</span>
					: (
						<span className="font-mono text-sm font-bold tabular-nums">
							${total.toFixed(2)}
							{unpricedCount > 0
								? <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">+ {unpricedCount} sin precio</span>
								: null}
						</span>
					)}
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-mono text-xs tabular-nums text-muted-foreground">
					{formatOrderTimestamp(order.createdAt)}
				</span>

				{showConfirmButton
					? (
						<Button
							size="sm"
							className="h-7 px-2 text-xs"
							onClick={(e) =>
							{
								e.stopPropagation();
								onConfirm?.();
							}}
						>
							Confirmar
						</Button>
					)
					: null}
			</div>
		</div>
	);
});
