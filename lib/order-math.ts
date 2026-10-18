/**
 * Shared by LineItems and OrderOverview (slice 2 of the product-pricing
 * block) so quantity × price math — and its null handling — lives in one
 * place, not duplicated with a risk of silently diverging.
 *
 * Returns null (not 0) when pricePerUnit is null, so callers can tell
 * "unpriced line" apart from "line that costs nothing" and render
 * "Sin precio" instead of a misleading $0.
 */
export function calculateLineTotal(quantity: number, pricePerUnit: number | null): number | null
{
	if (pricePerUnit === null)
	{
		return null;
	}
	return quantity * pricePerUnit;
}

/**
 * Mirrors orders.status's db check constraint (core_schema.sql) — the
 * kanban's 4 columns map 1:1 onto these, no new enum values needed.
 */
export const ORDER_STATUSES = ["pending", "confirmed", "dispatched", "delivered"] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

function isOrderStatus(status: string): status is OrderStatus
{
	return (ORDER_STATUSES as readonly string[]).includes(status);
}

export interface OrderTotal
{
	/** Sum of priced lines only — 0 if none are priced, never a fabricated value. */
	total: number;
	/** Count of lines with no price_at_order, shown alongside total as "+N sin precio" (slice 2's OrderOverview pattern). */
	unpricedCount: number;
}

/**
 * Slice 3, Decision 9: sums ONLY priced lines and reports the unpriced count
 * alongside, rather than either fabricating a 0 for a fully-unpriced order or
 * silently omitting unpriced lines from a mixed order's total.
 */
export function calculateOrderTotal(items: { quantity: number; priceAtOrder: number | null }[]): OrderTotal
{
	const unpricedCount = items.filter((item) => item.priceAtOrder === null).length;
	const total = items.reduce((sum, item) => sum + (calculateLineTotal(item.quantity, item.priceAtOrder) ?? 0), 0);
	return { total, unpricedCount };
}

/**
 * Buckets orders into the kanban's 4 columns. An order whose status isn't
 * one of the 4 known values (shouldn't happen — the db check constraint
 * already enforces this) is dropped rather than thrown on, since this is
 * pure render-prep, not validation.
 */
export function groupOrdersByStatus<T extends { status: string }>(orders: T[]): Record<OrderStatus, T[]>
{
	const groups: Record<OrderStatus, T[]> = { pending: [], confirmed: [], dispatched: [], delivered: [] };
	for (const order of orders)
	{
		if (isOrderStatus(order.status))
		{
			groups[order.status].push(order);
		}
	}
	return groups;
}
