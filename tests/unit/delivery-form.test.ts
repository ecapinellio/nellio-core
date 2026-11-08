import { describe, expect, it } from "vitest";
import { deliveryOutcome, initialLines, linesForRpc, validateDelivery, type DeliveryForm } from "@/lib/orders/delivery-form";
import { describeError, driverErrorMessage, groupDriverOrders, isAlreadyUploaded, isNetworkError } from "@/lib/orders/driver-orders";
import { DEFAULT_STATUSES } from "@/lib/orders/board";
import type { DriverOrder } from "@/lib/orders/actions-client";

const items = [
	{ id: "a", product_name: "Cloro", quantity: 10, unit: "gal", delivered_quantity: null },
	{ id: "b", product_name: "Soda", quantity: 2.5, unit: null, delivered_quantity: null },
];
const settings = { require_signature: true, require_receiver_name: true, require_photo: false };

function form(overrides: Partial<DeliveryForm> = {}): DeliveryForm
{
	return {
		lines: initialLines(items),
		receiverName: "Ana",
		hasSignature: true,
		hasPhoto: false,
		paymentMethod: "",
		amount: "",
		...overrides,
	};
}

describe("initialLines()", () =>
{
	it("delivers everything by default", () =>
	{
		const lines = initialLines(items);
		expect(lines.map((l) => l.delivered)).toEqual(["10", "2.5"]);
		expect(lines.every((l) => l.reason === "")).toBe(true);
	});
});

describe("deliveryOutcome()", () =>
{
	it("is delivered when every line is complete", () =>
	{
		expect(deliveryOutcome(initialLines(items))).toBe("delivered");
	});
	it("is partial when some line is short", () =>
	{
		const lines = initialLines(items);
		lines[0].delivered = "4";
		expect(deliveryOutcome(lines)).toBe("partially_delivered");
	});
	it("is invalid when nothing is delivered or a quantity is bad", () =>
	{
		const zero = initialLines(items).map((l) => ({ ...l, delivered: "0" }));
		expect(deliveryOutcome(zero)).toBe("invalid");
		const bad = initialLines(items);
		bad[0].delivered = "11";
		expect(deliveryOutcome(bad)).toBe("invalid");
		bad[0].delivered = "";
		expect(deliveryOutcome(bad)).toBe("invalid");
		bad[0].delivered = "abc";
		expect(deliveryOutcome(bad)).toBe("invalid");
	});
});

describe("validateDelivery()", () =>
{
	it("accepts a complete form", () =>
	{
		expect(validateDelivery(form(), settings)).toEqual([]);
	});
	it("asks for what the tenant requires", () =>
	{
		const errors = validateDelivery(form({ receiverName: " ", hasSignature: false }), { ...settings, require_photo: true });
		expect(errors).toEqual(["Falta el nombre de quien recibe.", "Falta la firma.", "Falta la foto."]);
	});
	it("does not ask for what is switched off", () =>
	{
		const off = { require_signature: false, require_receiver_name: false, require_photo: false };
		expect(validateDelivery(form({ receiverName: "", hasSignature: false }), off)).toEqual([]);
	});
	it("asks for a reason on a short line", () =>
	{
		const lines = initialLines(items);
		lines[1].delivered = "1";
		expect(validateDelivery(form({ lines }), settings)).toEqual(["Falta el motivo de Soda."]);
	});
	it("rejects an amount without a method, or on credit", () =>
	{
		expect(validateDelivery(form({ amount: "50" }), settings)).toEqual(["Elige el método de cobro."]);
		expect(validateDelivery(form({ amount: "50", paymentMethod: "credit" }), settings)).toEqual(["A crédito no se cobra monto."]);
		expect(validateDelivery(form({ amount: "-1", paymentMethod: "cash" }), settings)).toEqual(["El monto no es válido."]);
		expect(validateDelivery(form({ amount: "50", paymentMethod: "cash" }), settings)).toEqual([]);
	});
	it("rejects an all-zero delivery", () =>
	{
		const lines = initialLines(items).map((l) => ({ ...l, delivered: "0", reason: "refused" }));
		expect(validateDelivery(form({ lines }), settings)).toEqual(["No se entregó nada: usa No se pudo entregar."]);
	});
});

describe("linesForRpc()", () =>
{
	it("sends reason only for short lines", () =>
	{
		const lines = initialLines(items);
		lines[0].delivered = "4";
		lines[0].reason = "short";
		expect(linesForRpc(lines)).toEqual([
			{ orderItemId: "a", deliveredQuantity: 4, reason: "short" },
			{ orderItemId: "b", deliveredQuantity: 2.5 },
		]);
	});
});

function order(id: string, status: string, category: string): DriverOrder
{
	return {
		id, status, status_label: status, category, delivery_date: null, delivery_window: null, notes: null,
		status_changed_at: "", customer: { name: id, address: null, phone: null }, items: [], total: null, attempt: 0,
	};
}

describe("groupDriverOrders()", () =>
{
	const orders = [
		order("c", "confirmed", "preparing"),
		order("a", "accepted", "preparing"),
		order("d", "dispatched", "in_transit"),
		order("f", "delivery_failed", "in_transit"),
		order("x", "delivered", "delivered"),
		order("y", "cancelled", "cancelled"),
	];
	it("asks acceptance when required", () =>
	{
		const g = groupDriverOrders(orders, DEFAULT_STATUSES, true);
		expect(g.toAccept.map((o) => o.id)).toEqual(["c"]);
		expect(g.toPickUp.map((o) => o.id)).toEqual(["a"]);
		expect(g.inTransit.map((o) => o.id)).toEqual(["d"]);
		expect(g.failed.map((o) => o.id)).toEqual(["f"]);
		expect(g.closed.map((o) => o.id)).toEqual(["x", "y"]);
	});
	it("goes straight to pick up when acceptance is off", () =>
	{
		const g = groupDriverOrders(orders, DEFAULT_STATUSES, false);
		expect(g.toAccept).toEqual([]);
		expect(g.toPickUp.map((o) => o.id)).toEqual(["c", "a"]);
	});
});

describe("driver error helpers", () =>
{
	it("maps codes to Spanish", () =>
	{
		expect(driverErrorMessage("PT409")).toBe("Alguien cambió este pedido.");
		expect(driverErrorMessage("P0002")).toBe("Este pedido ya no está asignado a ti.");
		expect(driverErrorMessage("whatever")).toBe("No se pudo guardar. Intenta de nuevo.");
	});
	it("tells the driver what happened and whether to reload", () =>
	{
		expect(describeError({ code: "P0002", message: "x" }, true)).toEqual({ message: "Este pedido ya no está asignado a ti.", reload: true });
		expect(describeError({ code: "", message: "TypeError: Failed to fetch" }, true).reload).toBe(false);
		expect(describeError({ code: "x", message: "boom" }, false).message).toBe("Sin señal. Intenta de nuevo cuando tengas conexión.");
	});
	it("spots network failures and repeated uploads", () =>
	{
		expect(isNetworkError("TypeError: Failed to fetch", true)).toBe(true);
		expect(isNetworkError("anything", false)).toBe(true);
		expect(isNetworkError("duplicate", true)).toBe(false);
		expect(isAlreadyUploaded("The resource already exists")).toBe(true);
		expect(isAlreadyUploaded("nope")).toBe(false);
	});
});
