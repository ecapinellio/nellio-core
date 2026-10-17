import { describe, expect, it } from "vitest";
import { calculateLineTotal } from "@/lib/order-math";

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
