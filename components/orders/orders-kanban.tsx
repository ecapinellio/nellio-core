"use client";

import { useEffect, useMemo, useState } from "react";
import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { createClient } from "@/lib/supabase/client";
import { listOrdersForKanban, updateOrderStatus, type KanbanOrder } from "@/lib/supabase/queries";
import { ORDER_STATUSES, groupOrdersByStatus, isOrderStatus, type OrderStatus } from "@/lib/order-math";
import { KanbanColumn } from "@/components/orders/kanban-column";
import { OrderCard } from "@/components/orders/order-card";

function SortableOrderCard({
	order,
	showConfirmButton,
	onConfirm,
}: {
	order: KanbanOrder;
	showConfirmButton: boolean;
	onConfirm: () => void;
})
{
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: order.id });

	return (
		<OrderCard
			ref={setNodeRef}
			order={order}
			showConfirmButton={showConfirmButton}
			onConfirm={onConfirm}
			isDragging={isDragging}
			style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
			dragHandleProps={{ ...attributes, ...listeners }}
		/>
	);
}

function DroppableColumn({
	status,
	orders,
	onConfirm,
}: {
	status: OrderStatus;
	orders: KanbanOrder[];
	onConfirm: (orderId: string) => void;
})
{
	const { setNodeRef, isOver } = useDroppable({ id: status });

	return (
		<KanbanColumn ref={setNodeRef} status={status} count={orders.length} isOver={isOver}>
			<SortableContext items={orders.map((order) => order.id)} strategy={verticalListSortingStrategy}>
				{orders.map((order) => (
					<SortableOrderCard
						key={order.id}
						order={order}
						showConfirmButton={status === "pending"}
						onConfirm={() => onConfirm(order.id)}
					/>
				))}
			</SortableContext>
		</KanbanColumn>
	);
}

/**
 * over.id from @dnd-kit can be either a column id (dropped in empty space)
 * or another card's id (dropped near/on a card) — resolve to the column's
 * status either way.
 */
function resolveTargetStatus(overId: string, orders: KanbanOrder[]): OrderStatus | null
{
	if (isOrderStatus(overId))
	{
		return overId;
	}
	const target = orders.find((order) => order.id === overId);
	return target && isOrderStatus(target.status) ? target.status : null;
}

/**
 * Eng-review Decision 4: any column → any column, no transition validation.
 * RLS/role (T8) already gates WHO can move a card; the sequence they move
 * it in isn't enforced here.
 */
export function OrdersKanban()
{
	const supabase = useMemo(() => createClient(), []);
	const [orders, setOrders] = useState<KanbanOrder[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);

	useEffect(() =>
	{
		let active = true;
		listOrdersForKanban(supabase).then(({ data, error }) =>
		{
			if (!active)
			{
				return;
			}
			if (error)
			{
				setLoadError(true);
				return;
			}
			setOrders(data);
		});
		return () =>
		{
			active = false;
		};
	}, [supabase]);

	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const groups = useMemo(() => groupOrdersByStatus(orders ?? []), [orders]);
	const activeOrder = orders?.find((order) => order.id === activeId) ?? null;

	// Optimistic update, reverted on error (failure mode: network error
	// mid-drag) — the operator sees the move happen immediately, not after
	// a round trip, since that's the whole point of drag-and-drop.
	async function moveOrder(orderId: string, newStatus: OrderStatus)
	{
		if (!orders)
		{
			return;
		}
		const current = orders.find((order) => order.id === orderId);
		if (!current || current.status === newStatus)
		{
			return;
		}

		const previous = orders;
		setActionError(null);
		setOrders(orders.map((order) => (order.id === orderId ? { ...order, status: newStatus } : order)));

		const { error } = await updateOrderStatus(supabase, orderId, newStatus);
		if (error)
		{
			setOrders(previous);
			setActionError("No se pudo actualizar el pedido. Intenta de nuevo.");
		}
	}

	function handleDragStart(event: DragStartEvent)
	{
		setActiveId(String(event.active.id));
	}

	function handleDragEnd(event: DragEndEvent)
	{
		setActiveId(null);
		const { active, over } = event;
		if (!over || !orders)
		{
			return;
		}
		const newStatus = resolveTargetStatus(String(over.id), orders);
		if (newStatus)
		{
			moveOrder(String(active.id), newStatus);
		}
	}

	if (loadError)
	{
		return <p className="p-4 text-sm text-destructive">No se pudieron cargar los pedidos.</p>;
	}

	if (orders === null)
	{
		return <p className="p-4 text-sm text-muted-foreground">Cargando pedidos...</p>;
	}

	return (
		<div className="flex flex-col gap-3">
			{actionError ? <p className="text-sm text-destructive">{actionError}</p> : null}

			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
			>
				<div className="flex h-[calc(100vh-10rem)] gap-4 overflow-x-auto pb-2">
					{ORDER_STATUSES.map((status) => (
						<DroppableColumn
							key={status}
							status={status}
							orders={groups[status]}
							onConfirm={(orderId) => moveOrder(orderId, "confirmed")}
						/>
					))}
				</div>

				<DragOverlay>
					{activeOrder ? <OrderCard order={activeOrder} isDragging /> : null}
				</DragOverlay>
			</DndContext>
		</div>
	);
}
