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
import { listOrderStatuses, listOrdersForKanban, type KanbanOrder } from "@/lib/supabase/queries";
import { boardColumns, groupOrdersByColumn } from "@/lib/orders/board";
import { canOfficeDrag, type OrderStatusDef } from "@/lib/orders/fulfillment";
import { AssignOrderPanel, type AssignOutcome } from "@/components/orders/assign-order-panel";
import { KanbanColumn } from "@/components/orders/kanban-column";
import { OrderCard } from "@/components/orders/order-card";
import { OrderDetailPanel } from "@/components/orders/order-detail-panel";
import { OrdersMobileBoard } from "@/components/orders/orders-mobile-board";

function SortableOrderCard({
	order,
	status,
	now,
	draggable,
	showConfirmButton,
	onConfirm,
	onOpenDetail,
}: {
	order: KanbanOrder;
	status: OrderStatusDef;
	now: Date;
	/** Only a not-yet-confirmed order can be dragged (canOfficeDrag); the rest are read-only. */
	draggable: boolean;
	showConfirmButton: boolean;
	onConfirm: () => void;
	onOpenDetail: () => void;
})
{
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: order.id, disabled: !draggable });

	return (
		<OrderCard
			ref={setNodeRef}
			order={order}
			status={status}
			now={now}
			showConfirmButton={showConfirmButton}
			onConfirm={onConfirm}
			onOpenDetail={onOpenDetail}
			isDragging={isDragging}
			style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
			dragHandleProps={draggable ? { ...attributes, ...listeners } : undefined}
		/>
	);
}

function DroppableColumn({
	status,
	orders,
	now,
	accepts,
	onConfirm,
	onOpenDetail,
}: {
	status: OrderStatusDef;
	orders: KanbanOrder[];
	now: Date;
	/** Whether the card being dragged may land here; with no drag in progress, nothing is highlighted. */
	accepts: boolean;
	onConfirm: (orderId: string) => void;
	onOpenDetail: (orderId: string) => void;
})
{
	const { setNodeRef, isOver } = useDroppable({ id: status.key, disabled: !accepts });

	return (
		<KanbanColumn ref={setNodeRef} status={status} count={orders.length} isOver={isOver && accepts}>
			<SortableContext items={orders.map((order) => order.id)} strategy={verticalListSortingStrategy}>
				{orders.map((order) => (
					<SortableOrderCard
						key={order.id}
						order={order}
						status={status}
						now={now}
						draggable={status.step === "created"}
						showConfirmButton={status.step === "created"}
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
 * status key either way.
 */
function resolveTargetKey(overId: string, columns: OrderStatusDef[], orders: KanbanOrder[]): string | null
{
	if (columns.some((c) => c.key === overId))
	{
		return overId;
	}
	return orders.find((order) => order.id === overId)?.status ?? null;
}

const ERROR_MS = 8000;
const CHANGED_MESSAGE = "Alguien cambió este pedido. Ya se actualizó el tablero.";
const CLOCK_MS = 60_000;

interface Board
{
	orders: KanbanOrder[];
	statuses: OrderStatusDef[];
}

interface OrdersKanbanProps
{
	/**
	 * Fired after any change that could affect the stats dashboard (an
	 * assignment, a dialog save, or someone else's change arriving) —
	 * OrderStats is a sibling with its own fetch, it has no way to know this
	 * board just changed unless told.
	 */
	onOrderChanged?: () => void;
	/** From the JWT, picks the live channel; RLS still decides what arrives (ADR-010). */
	tenantId: string;
}

/**
 * The office only moves Pedido -> Confirmado (canOfficeDrag), and that opens
 * the driver/window panel: the card stays in Pedido until it's saved. Every
 * other column shows what drivers do, read-only, and follows it live.
 */
export function OrdersKanban({ onOrderChanged, tenantId }: OrdersKanbanProps)
{
	const supabase = useMemo(() => createClient(), []);
	const [board, setBoard] = useState<Board | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [openOrderId, setOpenOrderId] = useState<string | null>(null);
	const [assignOrderId, setAssignOrderId] = useState<string | null>(null);
	const [now, setNow] = useState(() => new Date());
	const refreshSequence = useRef(0);
	const dragging = useRef(false);
	const refreshAfterDrag = useRef(false);
	const loaded = useRef(false);
	const shownBoard = useRef<Board | null>(null);

	useEffect(() =>
	{
		shownBoard.current = board;
	}, [board]);

	useEffect(() =>
	{
		const timer = setInterval(() => setNow(new Date()), CLOCK_MS);
		return () => clearInterval(timer);
	}, []);

	// Every load goes through here: the first one, someone else's change,
	// coming back to the screen, after a save. Never mid-drag (the board would
	// shift under the finger), and only the newest response wins. A failed
	// refresh is quiet unless the user asked for it (`reportErrors`), and an
	// identical list (the echo of the user's own change) changes nothing.
	const refreshBoard = useCallback(async ({ reportErrors = false }: { reportErrors?: boolean } = {}) =>
	{
		if (dragging.current)
		{
			refreshAfterDrag.current = true;
			return;
		}
		const sequence = ++refreshSequence.current;
		const [statusResult, ordersResult] = await Promise.all([listOrderStatuses(supabase), listOrdersForKanban(supabase)]);
		if (sequence !== refreshSequence.current)
		{
			return;
		}
		if (statusResult.error || !statusResult.data || ordersResult.error || !ordersResult.data)
		{
			if (!loaded.current)
			{
				setLoadError(true);
			}
			else if (reportErrors)
			{
				setActionError("No se pudieron actualizar los pedidos. Refresca la página.");
			}
			return;
		}
		if (dragging.current)
		{
			refreshAfterDrag.current = true;
			return;
		}

		const next: Board = { orders: ordersResult.data, statuses: statusResult.data };
		const firstLoad = !loaded.current;
		loaded.current = true;
		setLoadError(false);
		if (JSON.stringify(next) === JSON.stringify(shownBoard.current))
		{
			return;
		}
		setBoard(next);
		if (!firstLoad)
		{
			onOrderChanged?.();
		}
	}, [supabase, onOrderChanged]);

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

	// First load, through the same path as every refresh.
	useEffect(() =>
	{
		const timer = setTimeout(refreshBoard, 0);
		return () => clearTimeout(timer);
	}, [refreshBoard]);

	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const columns = useMemo(() => boardColumns(board?.statuses ?? []), [board]);
	const groups = useMemo(() => groupOrdersByColumn(board?.orders ?? [], columns), [board, columns]);
	const activeOrder = board?.orders.find((order) => order.id === activeId) ?? null;
	const activeStatus = columns.find((c) => c.key === activeOrder?.status);
	const assignOrder = board?.orders.find((order) => order.id === assignOrderId) ?? null;

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
		const targetKey = over && board ? resolveTargetKey(String(over.id), columns, board.orders) : null;
		const target = columns.find((c) => c.key === targetKey);
		const order = board?.orders.find((o) => o.id === active.id);
		const from = columns.find((c) => c.key === order?.status);
		if (order && from && target && canOfficeDrag(from, target))
		{
			setAssignOrderId(order.id);
		}
		finishDrag();
	}

	function handleAssignDone(outcome: AssignOutcome)
	{
		setAssignOrderId(null);
		if (outcome === "stale")
		{
			setActionError(CHANGED_MESSAGE);
		}
		if (outcome !== "cancelled")
		{
			refreshBoard({ reportErrors: true });
		}
	}

	if (loadError)
	{
		return <p className="p-4 text-sm text-destructive">No se pudieron cargar los pedidos.</p>;
	}

	if (board === null)
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
				<OrdersMobileBoard
					columns={columns}
					groups={groups}
					now={now}
					error={actionError}
					onConfirm={setAssignOrderId}
					onOpenDetail={setOpenOrderId}
				/>
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
						{columns.map((status) => (
							<DroppableColumn
								key={status.key}
								status={status}
								orders={groups[status.key]}
								now={now}
								accepts={activeStatus !== undefined && canOfficeDrag(activeStatus, status)}
								onConfirm={setAssignOrderId}
								onOpenDetail={setOpenOrderId}
							/>
						))}
					</div>

					<DragOverlay>
						{activeOrder ? <OrderCard order={activeOrder} status={activeStatus} now={now} isDragging dragHandleProps={{}} /> : null}
					</DragOverlay>
				</DndContext>
			</div>

			<AssignOrderPanel
				order={assignOrder}
				mode="confirm"
				expectedStatus={assignOrder?.status ?? ""}
				onDone={handleAssignDone}
			/>

			<OrderDetailPanel
				orderId={openOrderId}
				onClose={() => setOpenOrderId(null)}
				onSaved={() =>
				{
					setOpenOrderId(null);
					refreshBoard({ reportErrors: true });
				}}
			/>
		</div>
	);
}
