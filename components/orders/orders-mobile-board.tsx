"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import type { KanbanOrder } from "@/lib/supabase/queries";
import { ORDER_STATUSES, ORDER_STATUS_LABELS, nextStatusAction, type OrderStatus } from "@/lib/order-math";
import { OrderCard } from "@/components/orders/order-card";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const UNDO_MS = 6000;

// A moved card leaves the list and the next one slides under the thumb, so a
// double tap would move a second order.
const DOUBLE_TAP_MS = 400;

const EMPTY_MESSAGES: Record<OrderStatus, string> = {
	pending: "No hay pedidos pendientes.",
	confirmed: "No hay pedidos confirmados.",
	dispatched: "No hay pedidos despachados.",
	delivered: "Todavía no hay pedidos entregados.",
};

interface UndoState
{
	orderId: string;
	from: OrderStatus;
	to: OrderStatus;
}

interface OrdersMobileBoardProps
{
	groups: Record<OrderStatus, KanbanOrder[]>;
	/** Resolves to false if the move failed (the board shows the error). */
	onMove: (orderId: string, status: OrderStatus) => Promise<boolean>;
	onOpenDetail: (orderId: string) => void;
}

/**
 * The board below `md` (design review, 2026-11-02): one status at a time
 * behind tabs that keep every count in view, and a next-step button instead of
 * dragging, which fights the list's scroll. "Mover a…" still reaches any
 * status, same as the desktop board (eng-review Decision 4).
 */
export function OrdersMobileBoard({ groups, onMove, onOpenDetail }: OrdersMobileBoardProps)
{
	const [activeStatus, setActiveStatus] = useState<OrderStatus>("pending");
	const [menuOrder, setMenuOrder] = useState<KanbanOrder | null>(null);
	const [undo, setUndo] = useState<UndoState | null>(null);
	const moveLocked = useRef(false);

	useEffect(() =>
	{
		if (!undo)
		{
			return;
		}
		const timer = setTimeout(() => setUndo(null), UNDO_MS);
		return () => clearTimeout(timer);
	}, [undo]);

	async function moveWithUndo(order: KanbanOrder, to: OrderStatus)
	{
		if (moveLocked.current)
		{
			return;
		}
		moveLocked.current = true;
		setTimeout(() =>
		{
			moveLocked.current = false;
		}, DOUBLE_TAP_MS);

		const from = order.status as OrderStatus;
		if (from !== to && await onMove(order.id, to))
		{
			setUndo({ orderId: order.id, from, to });
		}
	}

	function undoMove()
	{
		if (undo)
		{
			setUndo(null);
			onMove(undo.orderId, undo.from);
		}
	}

	const orders = groups[activeStatus];

	return (
		<div className={cn("flex flex-col gap-3", undo ? "pb-20" : null)}>
			<div role="group" aria-label="Filtrar por estado" className="sticky top-0 z-10 grid grid-cols-4 border-b border-border bg-background">
				{ORDER_STATUSES.map((status) =>
				{
					const active = status === activeStatus;
					return (
						<button
							key={status}
							type="button"
							aria-pressed={active}
							aria-label={`${ORDER_STATUS_LABELS[status]}, ${groups[status].length} ${groups[status].length === 1 ? "pedido" : "pedidos"}`}
							onClick={() => setActiveStatus(status)}
							style={active ? { borderColor: `var(--status-${status})` } : undefined}
							className={cn(
								"flex min-h-13 flex-col items-center justify-center border-b-2 border-transparent py-1",
								active ? "text-foreground" : "text-muted-foreground",
							)}
						>
							<span className="font-mono text-sm font-bold tabular-nums">{groups[status].length}</span>
							<span className={cn("text-[11px] leading-4", active ? "font-semibold" : "font-medium")}>
								{ORDER_STATUS_LABELS[status]}
							</span>
						</button>
					);
				})}
			</div>

			{orders.length === 0
				? (
					<div className="flex flex-col items-center gap-3 py-12 text-center">
						<p className="text-sm text-muted-foreground">{EMPTY_MESSAGES[activeStatus]}</p>
						{activeStatus === "pending"
							? <Button asChild className="h-11 px-4"><Link href="/orders/capture">Capturar pedido</Link></Button>
							: null}
					</div>
				)
				: orders.map((order) =>
				{
					const next = nextStatusAction(activeStatus);
					return (
						<OrderCard
							key={order.id}
							order={order}
							onOpenDetail={() => onOpenDetail(order.id)}
							actions={(
								<div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
									<Button
										variant="outline"
										className="size-11"
										aria-label={`Mover a otro estado: ${order.customerName}`}
										onClick={() => setMenuOrder(order)}
									>
										<MoreHorizontal className="size-5" />
									</Button>
									{next
										? <Button className="h-11 px-4" onClick={() => moveWithUndo(order, next.status)}>{next.label}</Button>
										: null}
								</div>
							)}
						/>
					);
				})}

			{activeStatus === "delivered" && orders.length > 0
				? (
					<Link href="/orders/historial" className="flex min-h-11 items-center justify-center text-sm font-medium text-primary underline-offset-4 hover:underline">
						Ver historial completo
					</Link>
				)
				: null}

			<Sheet open={menuOrder !== null} onOpenChange={(open) => !open && setMenuOrder(null)}>
				<SheetContent side="bottom">
					<SheetHeader>
						<SheetTitle>Mover a…</SheetTitle>
						<SheetDescription className="truncate">{menuOrder?.customerName}</SheetDescription>
					</SheetHeader>
					<div className="flex flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
						{ORDER_STATUSES.map((status) => (
							<button
								key={status}
								type="button"
								disabled={status === menuOrder?.status}
								onClick={() =>
								{
									if (menuOrder)
									{
										moveWithUndo(menuOrder, status);
									}
									setMenuOrder(null);
								}}
								className="flex min-h-12 items-center justify-between gap-2 border-b border-border last:border-b-0 disabled:opacity-60"
							>
								<OrderStatusBadge status={status} />
								{status === menuOrder?.status
									? <span className="text-xs text-muted-foreground">Estado actual</span>
									: null}
							</button>
						))}
					</div>
				</SheetContent>
			</Sheet>

			<div aria-live="polite">
				{undo
					? (
						<div className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex items-center justify-between gap-2 rounded-md bg-foreground py-1 pl-4 pr-1 text-sm text-background shadow-md">
							<span className="truncate">Movido a {ORDER_STATUS_LABELS[undo.to]}</span>
							<button type="button" onClick={undoMove} className="min-h-11 shrink-0 px-3 font-semibold underline underline-offset-4">
								Deshacer
							</button>
						</div>
					)
					: null}
			</div>
		</div>
	);
}
