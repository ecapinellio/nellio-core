import type { DriverOrder } from "@/lib/orders/actions-client";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";

export interface DriverGroups
{
	toAccept: DriverOrder[];
	toPickUp: DriverOrder[];
	inTransit: DriverOrder[];
	/** Failed attempt: waits for the office to reprogram, no driver action. */
	failed: DriverOrder[];
	closed: DriverOrder[];
}

/** Groups by the tenant's status step (names are theirs, steps are fixed). */
export function groupDriverOrders(orders: DriverOrder[], statuses: OrderStatusDef[], requireAcceptance: boolean): DriverGroups
{
	const groups: DriverGroups = { toAccept: [], toPickUp: [], inTransit: [], failed: [], closed: [] };
	for (const order of orders)
	{
		const step = statuses.find((s) => s.key === order.status)?.step;
		if (step === "confirmed")
		{
			(requireAcceptance ? groups.toAccept : groups.toPickUp).push(order);
		}
		else if (step === "accepted")
		{
			groups.toPickUp.push(order);
		}
		else if (step === "picked_up")
		{
			groups.inTransit.push(order);
		}
		else if (step === "delivery_failed")
		{
			groups.failed.push(order);
		}
		else if (order.category === "delivered" || order.category === "cancelled")
		{
			groups.closed.push(order);
		}
	}
	return groups;
}

export const GENERIC_ERROR = "No se pudo guardar. Intenta de nuevo.";
export const OFFLINE_ERROR = "Sin señal. Intenta de nuevo cuando tengas conexión.";

/** PT409: someone moved the order. P0002: it's no longer this driver's (RLS hides it, no Realtime event). */
export function driverErrorMessage(code: string | undefined): string
{
	switch (code)
	{
		case "PT409": return "Alguien cambió este pedido.";
		case "P0002": return "Este pedido ya no está asignado a ti.";
		case "22023": return "Este pedido ya no permite esta acción. Revisa su estado.";
		case "22004": return "Faltan datos obligatorios.";
		default: return GENERIC_ERROR;
	}
}

/** What to tell the driver, and whether the list is stale (the order moved or is no longer theirs). */
export function describeError(error: { code?: string; message: string }, online: boolean): { message: string; reload: boolean }
{
	if (isNetworkError(error.message, online))
	{
		return { message: OFFLINE_ERROR, reload: false };
	}
	return { message: driverErrorMessage(error.code), reload: error.code === "PT409" || error.code === "P0002" || error.code === "22023" };
}

export function isNetworkError(message: string, online: boolean): boolean
{
	return !online || /failed to fetch|network|load failed|fetch failed/i.test(message);
}

/** A retry after a partial success finds its proof already in the bucket. */
export function isAlreadyUploaded(message: string): boolean
{
	return /already exists/i.test(message);
}
