"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useOrdersLive } from "@/hooks/use-orders-live";
import { useRefreshOnReturn } from "@/hooks/use-refresh-on-return";
import { createClient } from "@/lib/supabase/client";
import { listOrdersForKanban, updateOrderStatus, type KanbanOrder } from "@/lib/supabase/queries";
import { ORDER_STATUSES, applyPendingMoves, groupOrdersByStatus, isOrderStatus, type OrderStatus } from "@/lib/order-math";
import { KanbanColumn } from "@/components/orders/kanban-column";
import { OrderCard } from "@/components/orders/order-card";
import { OrderDetailDialog } from "@/components/orders/order-detail-dialog";
import { OrdersMobileBoard } from "@/components/orders/orders-mobile-board";

function SortableOrderCard({
	order,
	showConfirmButton,
	onConfirm,
	onOpenDetail,
}: {
	order: KanbanOrder;
	showConfirmButton: boolean;
	onConfirm: () => void;
	onOpenDetail: () => void;
})
{
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: order.id });

	return (
		<OrderCard
			ref={setNodeRef}
			order={order}
			showConfirmButton={showConfirmButton}
			onConfirm={onConfirm}
			onOpenDetail={onOpenDetail}
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
	onOpenDetail,
}: {
	status: OrderStatus;
	orders: KanbanOrder[];
	onConfirm: (orderId: string) => void;
	onOpenDetail: (orderId: string) => void;
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
						onOpenDetail={() => onOpenDetail(order.id)}
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

const ERROR_MS = 8000;

interface OrdersKanbanProps
{
	/**
	 * Fired after any change that could affect the stats dashboard (status
	 * move or a dialog save) — OrderStats is a sibling with its own fetch,
	 * it has no way to know this board just mutated data unless told.
	 */
	onOrderChanged?: () => void;
	/** From the JWT, picks the live channel; RLS still decides what arrives (ADR-010). */
	tenantId: string;
}

/**
 * Eng-review Decision 4: any column → any column, no transition validation.
 * RLS/role (T8) already gates WHO can move a card; the sequence they move
 * it in isn't enforced here.
 */
export function OrdersKanban({ onOrderChanged, tenantId }: OrdersKanbanProps)
{
	const supabase = useMemo(() => createClient(), []);
	const [orders, setOrders] = useState<KanbanOrder[] | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openOrderId, setOpenOrderId] = useState<string | null>(null);
	const pendingMoves = useRef(new Map<string, OrderStatus>());
	// Bumped when a move starts or lands: a refetch that spans one re-reads.
	const movesVersion = useRef(0);
	const refreshSequence = useRef(0);
	const dragging = useRef(false);
	const refreshAfterDrag = useRef(false);

	const fetchLatestOrders = useCallback(async () =>
	{
		let version;
		let result;
		do
		{
			version = movesVersion.current;
			result = await listOrdersForKanban(supabase);
		}
		while (version !== movesVersion.current);
		return result;
	}, [supabase]);

	// Someone else's change, or coming back to the screen. Quiet: a failed
	// refresh keeps what's on screen instead of raising an error for something
	// the user didn't do. Never mid-drag (the board would shift under the
	// finger), and only the newest response wins.
	const refreshBoard = useCallback(async () =>
	{
		if (dragging.current)
		{
			refreshAfterDrag.current = true;
			return;
		}
		const sequence = ++refreshSequence.current;
		const { data, error } = await fetchLatestOrders();
		if (error || !data || sequence !== refreshSequence.current)
		{
			return;
		}
		if (dragging.current)
		{
			refreshAfterDrag.current = true;
			return;
		}
		setOrders(applyPendingMoves(data, pendingMoves.current));
		onOrderChanged?.();
	}, [fetchLatestOrders, onOrderChanged]);

	useRefreshOnReturn(refreshBoard);
	useOrdersLive(supabase, tenantId, refreshBoard);

	useEffect(() =>
	{
		if (!actionError)
		{
			return;
		}
		const timer = setTimeout(() => setActionError(null), ERROR_MS);
		return () => clearTimeout(timer);
	}, [actionError]);

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

	/** Post-save refetch (eng-review Decision 6) — a full re-fetch, not an in-memory patch, since this is a deliberate low-frequency action, not a frequent drag. */
	async function refetchOrders()
	{
		const { data, error } = await fetchLatestOrders();
		if (error || !data)
		{
			setActionError("No se pudieron actualizar los pedidos. Refrescá la página.");
			return;
		}
		setOrders(applyPendingMoves(data, pendingMoves.current));
	}

	// Optimistic update, reverted on error (failure mode: network error
	// mid-drag) — the operator sees the move happen immediately, not after
	// a round trip, since that's the whole point of drag-and-drop.
	// Functional updates, and the revert touches this order only: on a phone
	// two quick moves can overlap, and restoring a snapshot would undo the
	// other. One write per order at a time, so they can't land out of order.
	async function moveOrder(orderId: string, newStatus: OrderStatus): Promise<boolean>
	{
		const current = orders?.find((order) => order.id === orderId);
		if (!current)
		{
			setActionError("Ese pedido ya no está en el tablero.");
			return false;
		}
		if (current.status === newStatus || pendingMoves.current.has(orderId))
		{
			return false;
		}

		const setStatus = (status: string) => setOrders((all) =>
			all && all.map((order) => (order.id === orderId ? { ...order, status } : order)));

		setActionError(null);
		setStatus(newStatus);
		pendingMoves.current.set(orderId, newStatus);
		movesVersion.current++;

		const { error } = await updateOrderStatus(supabase, orderId, newStatus, current.status);
		pendingMoves.current.delete(orderId);
		movesVersion.current++;

		if (error)
		{
			setStatus(current.status);
			setActionError(error.code === "PGRST116"
				? "Este pedido cambió mientras tenías la pantalla abierta. Revisa su estado actual."
				: "No se pudo actualizar el pedido. Intenta de nuevo.");
			refetchOrders();
			return false;
		}
		onOrderChanged?.();
		return true;
	}

	function handleDragStart(event: DragStartEvent)
	{
		dragging.current = true;
		setActiveId(String(event.active.id));
	}

	function finishDrag()
	{
		dragging.current = false;
		setActiveId(null);
		if (refreshAfterDrag.current)
		{
			refreshAfterDrag.current = false;
			refreshBoard();
		}
	}

	function handleDragEnd(event: DragEndEvent)
	{
		const { active, over } = event;
		const newStatus = over && orders ? resolveTargetStatus(String(over.id), orders) : null;
		if (newStatus)
		{
			moveOrder(String(active.id), newStatus);
		}
		finishDrag();
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
			{actionError
				? (
					<p role="alert" className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 rounded-md border border-destructive bg-background px-4 py-3 text-sm font-medium text-destructive shadow-md md:inset-x-auto md:right-6 md:max-w-md">
						{actionError}
					</p>
				)
				: null}

			<div className="md:hidden">
				<OrdersMobileBoard groups={groups} error={actionError} onMove={moveOrder} onOpenDetail={setOpenOrderId} />
			</div>

			<div className="hidden md:block">
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
					onDragCancel={finishDrag}
				>
					<div className="flex h-[calc(100vh-10rem)] gap-4 overflow-x-auto pb-2">
						{ORDER_STATUSES.map((status) => (
							<DroppableColumn
								key={status}
								status={status}
								orders={groups[status]}
								onConfirm={(orderId) => moveOrder(orderId, "confirmed")}
								onOpenDetail={setOpenOrderId}
							/>
						))}
					</div>

					<DragOverlay>
						{activeOrder ? <OrderCard order={activeOrder} isDragging dragHandleProps={{}} /> : null}
					</DragOverlay>
				</DndContext>
			</div>

			<OrderDetailDialog
				orderId={openOrderId}
				onClose={() => setOpenOrderId(null)}
				onSaved={() =>
				{
					setOpenOrderId(null);
					refetchOrders();
					onOrderChanged?.();
				}}
			/>
		</div>
	);
}
