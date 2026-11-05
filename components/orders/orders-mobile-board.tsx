"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { KanbanOrder } from "@/lib/supabase/queries";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";
import { OrderCard } from "@/components/orders/order-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusColor } from "@/lib/orders/board";

interface OrdersMobileBoardProps
{
	columns: OrderStatusDef[];
	groups: Record<string, KanbanOrder[]>;
	now: Date;
	/** The board shows it in a fixed bar; here it keeps the list clear of it. */
	error: string | null;
	/** "Confirmar" on a Pedido card: the board opens the driver and window panel. */
	onConfirm: (orderId: string) => void;
	onOpenDetail: (orderId: string) => void;
}

/**
 * The board below `md` (design review, 2026-11-02): one status at a time
 * behind tabs that keep every count in view. The only action here is
 * "Confirmar" on Pedido; everything else is read-only, or lives in the
 * order's detail. The tabs scroll sideways because there are more statuses
 * than fit across 375px.
 */
export function OrdersMobileBoard({ columns, groups, now, error, onConfirm, onOpenDetail }: OrdersMobileBoardProps)
{
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const boardRef = useRef<HTMLDivElement>(null);

	// First tab until the user picks one; a status that stops existing falls back too.
	const active = columns.find((c) => c.key === activeKey) ?? columns[0];

	function selectTab(key: string)
	{
		setActiveKey(key);
		const board = boardRef.current;
		if (board && board.getBoundingClientRect().top < 0)
		{
			board.scrollIntoView();
		}
	}

	if (!active)
	{
		return null;
	}

	const orders = groups[active.key] ?? [];
	const isFirst = active.key === columns[0].key;

	return (
		<div ref={boardRef} className={cn("flex flex-col gap-3", error ? "pb-20" : null)}>
			<div role="group" aria-label="Filtrar por estado" className="sticky top-0 z-10 flex overflow-x-auto border-b border-border bg-background">
				{columns.map((column) =>
				{
					const isActive = column.key === active.key;
					const count = groups[column.key]?.length ?? 0;
					return (
						<button
							key={column.key}
							type="button"
							aria-pressed={isActive}
							aria-label={`${column.label}, ${count} ${count === 1 ? "pedido" : "pedidos"}`}
							onClick={() => selectTab(column.key)}
							style={isActive ? { borderColor: statusColor(column) } : undefined}
							className={cn(
								"flex min-h-13 min-w-24 shrink-0 flex-col items-center justify-center border-b-2 border-transparent px-2 py-1 active:bg-muted",
								isActive ? "text-foreground" : "text-muted-foreground",
							)}
						>
							<span className="font-mono text-sm font-bold tabular-nums">{count}</span>
							<span className={cn("text-[11px] leading-4", isActive ? "font-semibold" : "font-medium")}>
								{column.label}
							</span>
						</button>
					);
				})}
			</div>

			{orders.length === 0
				? (
					<div className="flex flex-col items-center gap-3 py-12 text-center">
						<p className="text-sm text-muted-foreground">Sin pedidos en {active.label}.</p>
						{isFirst
							? <Button asChild className="h-11 px-4"><Link href="/orders/capture">Capturar pedido</Link></Button>
							: null}
					</div>
				)
				: orders.map((order) => (
					<OrderCard
						key={order.id}
						order={order}
						status={active}
						now={now}
						onOpenDetail={() => onOpenDetail(order.id)}
						actions={active.step === "created"
							? (
								<div onClick={(e) => e.stopPropagation()}>
									<Button
										className="h-11 px-4"
										aria-label={`Confirmar: ${order.customerName}`}
										onClick={() => onConfirm(order.id)}
									>
										Confirmar
									</Button>
								</div>
							)
							: undefined}
					/>
				))}

			{active.category === "delivered" && orders.length > 0
				? (
					<Link href="/orders/historial" className="flex min-h-11 items-center justify-center text-sm font-medium text-primary underline-offset-4 hover:underline">
						Ver historial completo
					</Link>
				)
				: null}
		</div>
	);
}
