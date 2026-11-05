// Fixed vocabulary of the fulfillment flow. Tenants name their own statuses
// (order_statuses) but each one maps onto one category and, optionally, a step.

export const ORDER_CATEGORIES = ["to_confirm", "preparing", "in_transit", "delivered", "cancelled"] as const;
export type OrderCategory = typeof ORDER_CATEGORIES[number];

export const ORDER_STEPS = [
	"created", "confirmed", "accepted", "picked_up", "delivery_failed", "delivered", "partially_delivered", "cancelled",
] as const;
export type OrderStep = typeof ORDER_STEPS[number];

export interface OrderStatusDef
{
	key: string;
	label: string;
	category: OrderCategory;
	step: OrderStep | null;
	position: number;
}

/** Reasons for a failed delivery or a cancellation. */
export const FAILURE_REASONS: Record<string, string> = {
	customer_closed: "Cliente cerrado",
	customer_refused: "Cliente rechazó",
	wrong_address: "Dirección incorrecta",
	other: "Otro",
};

export const SHORTFALL_REASONS: Record<string, string> = {
	refused: "No lo quiso",
	damaged: "Venía dañado",
	short: "No alcanzó",
	other: "Otro",
};

export const PAYMENT_METHODS: Record<string, string> = {
	cash: "Efectivo",
	check: "Cheque",
	transfer: "Transferencia",
	credit: "Crédito",
};

/** The office only drags created -> confirmed; everything else has its own action. */
export function canOfficeDrag(from: OrderStatusDef, to: OrderStatusDef): boolean
{
	return from.step === "created" && to.step === "confirmed";
}

/** Lines, prices, customer and notes can change up to "accepted". */
export function isEditable(status: OrderStatusDef): boolean
{
	return status.step === "created" || status.step === "confirmed" || status.step === "accepted";
}

export function canCancel(status: OrderStatusDef): boolean
{
	return isEditable(status) || status.step === "delivery_failed";
}

export function hoursSince(iso: string, now: Date): number
{
	return Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000);
}
