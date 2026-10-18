import { describe, expect, it } from "vitest";
import { calculateLineTotal, calculateOrderTotal, groupOrdersByStatus } from "@/lib/order-math";

describe("calculateLineTotal", () =>
{
	it("multiplies quantity by price per unit", () =>
	{
		expect(calculateLineTotal(3, 10.5)).toBe(31.5);
	});

	it("returns null (not 0 or NaN) when price_per_unit is null", () =>
	{
		expect(calculateLineTotal(3, null)).toBeNull();
	});

	it("handles fractional quantities", () =>
	{
		expect(calculateLineTotal(0.5, 100)).toBe(50);
	});

	it("returns 0 for a zero price, distinct from null", () =>
	{
		// Degenerate input, not reachable via the UI (price_per_unit is
		// either null or > 0 per the DB check constraint) — still worth
		// locking in that 0 and null are handled differently, not conflated.
		expect(calculateLineTotal(3, 0)).toBe(0);
	});
});

describe("calculateOrderTotal", () =>
{
	it("sums priced lines only, unpricedCount 0, when every line has a price", () =>
	{
		const result = calculateOrderTotal([
			{ quantity: 2, priceAtOrder: 10 },
			{ quantity: 1, priceAtOrder: 5.5 },
		]);
		expect(result).toEqual({ total: 25.5, unpricedCount: 0 });
	});

	it("returns total 0 (not a fabricated number) when every line is unpriced", () =>
	{
		const result = calculateOrderTotal([
			{ quantity: 2, priceAtOrder: null },
			{ quantity: 1, priceAtOrder: null },
		]);
		expect(result).toEqual({ total: 0, unpricedCount: 2 });
	});

	it("mixed order: sums only the priced lines and reports the unpriced count alongside (Decision 9)", () =>
	{
		const result = calculateOrderTotal([
			{ quantity: 2, priceAtOrder: 10 },
			{ quantity: 3, priceAtOrder: null },
			{ quantity: 1, priceAtOrder: 5.5 },
		]);
		expect(result).toEqual({ total: 25.5, unpricedCount: 1 });
	});

	it("returns total 0, unpricedCount 0 for an empty order", () =>
	{
		expect(calculateOrderTotal([])).toEqual({ total: 0, unpricedCount: 0 });
	});
});

describe("groupOrdersByStatus", () =>
{
	it("buckets orders into their matching status column", () =>
	{
		const orders = [
			{ id: "1", status: "pending" },
			{ id: "2", status: "confirmed" },
			{ id: "3", status: "pending" },
			{ id: "4", status: "dispatched" },
			{ id: "5", status: "delivered" },
		];
		const groups = groupOrdersByStatus(orders);
		expect(groups.pending.map((o) => o.id)).toEqual(["1", "3"]);
		expect(groups.confirmed.map((o) => o.id)).toEqual(["2"]);
		expect(groups.dispatched.map((o) => o.id)).toEqual(["4"]);
		expect(groups.delivered.map((o) => o.id)).toEqual(["5"]);
	});

	it("returns all 4 columns as empty arrays for an empty order list", () =>
	{
		expect(groupOrdersByStatus([])).toEqual({ pending: [], confirmed: [], dispatched: [], delivered: [] });
	});

	it("drops an order with an unrecognized status instead of throwing", () =>
	{
		const orders = [{ id: "1", status: "unknown_status" }];
		const groups = groupOrdersByStatus(orders);
		expect(groups).toEqual({ pending: [], confirmed: [], dispatched: [], delivered: [] });
	});
});
