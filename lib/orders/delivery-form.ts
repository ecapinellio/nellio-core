import type { DeliveryLineInput, DriverOrderItem } from "@/lib/orders/actions-client";
import { PAYMENT_METHODS } from "@/lib/orders/fulfillment";

// Pure form logic for the driver's delivery sheet. Quantities stay strings
// (what the input holds) and are parsed here, so "" and "abc" are caught.

export interface DeliveryLine
{
	orderItemId: string;
	productName: string;
	unit: string | null;
	ordered: number;
	delivered: string;
	reason: string;
}

export interface DeliveryForm
{
	lines: DeliveryLine[];
	receiverName: string;
	hasSignature: boolean;
	hasPhoto: boolean;
	paymentMethod: string;
	amount: string;
}

export interface DeliverySettings
{
	require_signature: boolean;
	require_receiver_name: boolean;
	require_photo: boolean;
}

export function initialLines(items: DriverOrderItem[]): DeliveryLine[]
{
	return items.map((i) => ({
		orderItemId: i.id,
		productName: i.product_name,
		unit: i.unit,
		ordered: i.quantity,
		delivered: String(i.quantity),
		reason: "",
	}));
}

/** The server takes at most two decimals and 0..ordered. NaN when the text isn't that. */
function parseDelivered(line: DeliveryLine): number
{
	const text = line.delivered.trim();
	if (!/^\d+(\.\d{1,2})?$/.test(text))
	{
		return NaN;
	}
	const value = Number(text);
	return value <= line.ordered ? value : NaN;
}

export function deliveryOutcome(lines: DeliveryLine[]): "delivered" | "partially_delivered" | "invalid"
{
	const quantities = lines.map(parseDelivered);
	if (quantities.some(Number.isNaN) || quantities.every((q) => q === 0))
	{
		return "invalid";
	}
	return quantities.some((q, i) => q < lines[i].ordered) ? "partially_delivered" : "delivered";
}

export function validateDelivery(form: DeliveryForm, settings: DeliverySettings): string[]
{
	const errors: string[] = [];

	for (const line of form.lines)
	{
		if (Number.isNaN(parseDelivered(line)))
		{
			errors.push(`La cantidad de ${line.productName} no es válida.`);
		}
		else if (parseDelivered(line) < line.ordered && !line.reason)
		{
			errors.push(`Falta el motivo de ${line.productName}.`);
		}
	}
	if (errors.length === 0 && deliveryOutcome(form.lines) === "invalid")
	{
		errors.push("No se entregó nada: usa No se pudo entregar.");
	}

	if (settings.require_receiver_name && !form.receiverName.trim())
	{
		errors.push("Falta el nombre de quien recibe.");
	}
	if (settings.require_signature && !form.hasSignature)
	{
		errors.push("Falta la firma.");
	}
	if (settings.require_photo && !form.hasPhoto)
	{
		errors.push("Falta la foto.");
	}

	const amountText = form.amount.trim();
	if (amountText)
	{
		const amount = Number(amountText);
		if (!Number.isFinite(amount) || amount < 0 || amount >= 100_000_000)
		{
			errors.push("El monto no es válido.");
		}
		else if (!form.paymentMethod)
		{
			errors.push("Elige el método de cobro.");
		}
		else if (form.paymentMethod === "credit")
		{
			errors.push("A crédito no se cobra monto.");
		}
	}
	if (form.paymentMethod && !(form.paymentMethod in PAYMENT_METHODS))
	{
		errors.push("El método de cobro no es válido.");
	}
	return errors;
}

/** The reason only travels with a short line. */
export function linesForRpc(lines: DeliveryLine[]): DeliveryLineInput[]
{
	return lines.map((l) =>
	{
		const delivered = parseDelivered(l);
		const base = { orderItemId: l.orderItemId, deliveredQuantity: delivered };
		if (delivered >= l.ordered)
		{
			return base;
		}
		return { ...base, reason: l.reason };
	});
}
