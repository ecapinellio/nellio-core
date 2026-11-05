import { FAILURE_REASONS, canCancel, type OrderStatusDef } from "@/lib/orders/fulfillment";

export interface DetailActions
{
	reassign: boolean;
	reprogram: boolean;
	cancel: boolean;
	correct: boolean;
	createPending: boolean;
}

/** Which buttons the detail shows for an order in this status. The server re-checks all of them. */
export function detailActions(status: OrderStatusDef | undefined, isAdmin: boolean): DetailActions
{
	const step = status?.step ?? null;
	return {
		reassign: step === "confirmed" || step === "accepted",
		reprogram: step === "delivery_failed",
		cancel: status !== undefined && canCancel(status),
		correct: isAdmin,
		createPending: step === "partially_delivered",
	};
}

/** Lines still owed after a partial delivery: ordered minus delivered, only the positive ones. */
export function pendingLines(
	items: { productId: string; quantity: number; deliveredQuantity: number | null }[],
): { productId: string; quantity: number }[]
{
	return items
		.map((i) => ({ productId: i.productId, quantity: i.quantity - (i.deliveredQuantity ?? i.quantity) }))
		.filter((l) => l.quantity > 0);
}

/** dd/mm/yyyy in local time. */
function slashDate(iso: string): string
{
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function pendingNote(createdAtIso: string): string
{
	return `Pendiente del pedido del ${slashDate(createdAtIso)}`;
}

const EVENT_LABELS: Record<string, string> = {
	create: "Pedido creado",
	assign: "Chofer asignado",
	accept: "Aceptado por el chofer",
	reject: "Rechazado por el chofer",
	pick_up: "Salió a entregar",
	fail: "Entrega fallida",
	deliver: "Entregado",
	cancel: "Cancelado",
	correct: "Estado corregido",
};

export function eventLabel(action: string): string
{
	return EVENT_LABELS[action] ?? action;
}

/** Known reason codes in Spanish, free text (a correction's reason) as is. */
export function reasonLabel(reason: string): string
{
	return FAILURE_REASONS[reason] ?? reason;
}
