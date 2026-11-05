import { describe, expect, it } from "vitest";
import { ORDER_STEPS, canCancel, canOfficeDrag, hoursSince, isEditable, type OrderStatusDef, type OrderStep } from "@/lib/orders/fulfillment";

function def(step: OrderStep): OrderStatusDef
{
	return { key: step, label: step, category: "preparing", step, position: 1 };
}

describe("canOfficeDrag", () =>
{
	it("only allows created -> confirmed", () =>
	{
		for (const from of ORDER_STEPS)
		{
			for (const to of ORDER_STEPS)
			{
				expect(canOfficeDrag(def(from), def(to))).toBe(from === "created" && to === "confirmed");
			}
		}
	});

	it("rejects statuses without a step", () =>
	{
		const custom: OrderStatusDef = { key: "x", label: "X", category: "preparing", step: null, position: 9 };
		expect(canOfficeDrag(def("created"), custom)).toBe(false);
		expect(canOfficeDrag(custom, def("confirmed"))).toBe(false);
	});
});

describe("isEditable / canCancel", () =>
{
	it("edits are allowed up to accepted", () =>
	{
		const editable = ["created", "confirmed", "accepted"];
		for (const step of ORDER_STEPS)
		{
			expect(isEditable(def(step))).toBe(editable.includes(step));
		}
	});

	it("cancel is allowed from created, confirmed, accepted and delivery_failed", () =>
	{
		const cancellable = ["created", "confirmed", "accepted", "delivery_failed"];
		for (const step of ORDER_STEPS)
		{
			expect(canCancel(def(step))).toBe(cancellable.includes(step));
		}
	});

	it("a status without a step is neither editable nor cancellable", () =>
	{
		const custom: OrderStatusDef = { key: "x", label: "X", category: "preparing", step: null, position: 9 };
		expect(isEditable(custom)).toBe(false);
		expect(canCancel(custom)).toBe(false);
	});
});

describe("hoursSince", () =>
{
	it("returns elapsed hours, never negative", () =>
	{
		const now = new Date("2026-11-05T12:00:00Z");
		expect(hoursSince("2026-11-05T09:00:00Z", now)).toBe(3);
		expect(hoursSince("2026-11-05T11:30:00Z", now)).toBe(0.5);
		expect(hoursSince("2026-11-05T13:00:00Z", now)).toBe(0);
	});
});
