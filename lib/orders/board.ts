import { hoursSince, type OrderStatusDef } from "@/lib/orders/fulfillment";

// Pure helpers for the office board: which columns exist, where each order
// goes, what colour a status gets and which warnings a card shows.

/** Columns = the tenant's statuses by position; cancelled orders don't go on the board. */
export function boardColumns(statuses: OrderStatusDef[]): OrderStatusDef[]
{
	return statuses
		.filter((s) => s.category !== "cancelled")
		.sort((a, b) => a.position - b.position);
}

/** One bucket per column; an order whose status isn't a column is dropped, not thrown on. */
export function groupOrdersByColumn<T extends { status: string }>(orders: T[], columns: OrderStatusDef[]): Record<string, T[]>
{
	const groups: Record<string, T[]> = Object.fromEntries(columns.map((c) => [c.key, []]));
	for (const order of orders)
	{
		groups[order.status]?.push(order);
	}
	return groups;
}

/**
 * Badge colour: the category picks the pipeline colour (DESIGN.md tokens);
 * the two steps that need the office's eye get their own mark.
 */
export function statusColor(def: Pick<OrderStatusDef, "category" | "step">): string
{
	if (def.step === "delivery_failed")
	{
		return "var(--destructive)";
	}
	if (def.step === "partially_delivered")
	{
		return "var(--status-pending)";
	}
	switch (def.category)
	{
		case "to_confirm": return "var(--status-pending)";
		case "preparing": return "var(--status-confirmed)";
		case "in_transit": return "var(--status-dispatched)";
		case "delivered": return "var(--status-delivered)";
		default: return "var(--user-inactive)";
	}
}

export interface CardNotes
{
	/** Whole hours since the driver was asked, once it's an hour or more with no answer. */
	unacceptedHours: number | null;
	/** Confirmed but nobody holds it (a driver rejected it, or it was never assigned). */
	noDriver: boolean;
	attempt: number | null;
	failed: boolean;
}

export function cardNotes(
	order: { driverName: string | null; statusChangedAt: string; attempt: number },
	def: Pick<OrderStatusDef, "step"> | undefined,
	now: Date,
): CardNotes
{
	const confirmed = def?.step === "confirmed";
	const hours = Math.floor(hoursSince(order.statusChangedAt, now));
	return {
		unacceptedHours: confirmed && order.driverName && hours >= 1 ? hours : null,
		noDriver: confirmed && !order.driverName,
		attempt: order.attempt >= 2 ? order.attempt : null,
		failed: def?.step === "delivery_failed",
	};
}

/**
 * What the assign panel shows and the status it saves against, frozen when it
 * opens: a refetch must not move `expectedStatus`, or a colleague's change
 * would be overwritten instead of rejected (PT409).
 */
export interface AssignSnapshot
{
	id: string;
	status: string;
	customerName: string;
	deliveryDate: string | null;
	deliveryWindow: string | null;
}

export function snapshotForAssign(
	orders: { id: string; status: string; customerName: string; deliveryDate: string | null; deliveryWindow: string | null }[],
	orderId: string,
): AssignSnapshot | null
{
	const o = orders.find((x) => x.id === orderId);
	return o ? { id: o.id, status: o.status, customerName: o.customerName, deliveryDate: o.deliveryDate, deliveryWindow: o.deliveryWindow } : null;
}

/** Keeps the snapshot only while its order is still on the board. */
export function keepSnapshot(snapshot: AssignSnapshot | null, orders: { id: string }[]): AssignSnapshot | null
{
	return snapshot && orders.some((o) => o.id === snapshot.id) ? snapshot : null;
}

/** Local calendar day as yyyy-mm-dd, what <input type="date"> and orders.delivery_date use. */
export function localDateString(now: Date): string
{
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** yyyy-mm-dd to dd-mm-yyyy by splitting, since parsing it as a Date would shift the day by timezone. */
export function formatDeliveryDate(date: string): string
{
	const [y, m, d] = date.split("-");
	return `${d}-${m}-${y}`;
}

/** The ECTEC defaults, for badges drawn where the tenant's list isn't loaded (table, detail). */
export const DEFAULT_STATUSES: OrderStatusDef[] = [
	{ key: "pending", label: "Pedido", category: "to_confirm", step: "created", position: 1 },
	{ key: "confirmed", label: "Confirmado", category: "preparing", step: "confirmed", position: 2 },
	{ key: "accepted", label: "Aceptado por chofer", category: "preparing", step: "accepted", position: 3 },
	{ key: "dispatched", label: "En camino", category: "in_transit", step: "picked_up", position: 4 },
	{ key: "delivery_failed", label: "Entrega fallida", category: "in_transit", step: "delivery_failed", position: 5 },
	{ key: "delivered", label: "Entregado", category: "delivered", step: "delivered", position: 6 },
	{ key: "partially_delivered", label: "Entregado parcial", category: "delivered", step: "partially_delivered", position: 7 },
	{ key: "cancelled", label: "Cancelado", category: "cancelled", step: "cancelled", position: 8 },
];
