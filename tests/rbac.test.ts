import { describe, expect, it } from "vitest";
import { isRole, isRouteAllowed } from "@/lib/rbac";

describe("isRouteAllowed()", () =>
{
	it("keeps / open to every role (driver needs somewhere to land)", () =>
	{
		expect(isRouteAllowed("/", "admin")).toBe(true);
		expect(isRouteAllowed("/", "operator")).toBe(true);
		expect(isRouteAllowed("/", "driver")).toBe(true);
	});

	it("allows /orders* for admin and operator, not driver", () =>
	{
		for (const path of ["/orders", "/orders/capture", "/orders/historial"])
		{
			expect(isRouteAllowed(path, "admin")).toBe(true);
			expect(isRouteAllowed(path, "operator")).toBe(true);
			expect(isRouteAllowed(path, "driver")).toBe(false);
		}
	});

	it("allows /products for admin and operator, not driver", () =>
	{
		expect(isRouteAllowed("/products", "admin")).toBe(true);
		expect(isRouteAllowed("/products", "operator")).toBe(true);
		expect(isRouteAllowed("/products", "driver")).toBe(false);
	});

	it("allows /admin* only for admin", () =>
	{
		expect(isRouteAllowed("/admin/users", "admin")).toBe(true);
		expect(isRouteAllowed("/admin/users", "operator")).toBe(false);
		expect(isRouteAllowed("/admin/users", "driver")).toBe(false);
	});

	it("falls back to admin-only for unlisted routes (fail-closed default)", () =>
	{
		expect(isRouteAllowed("/unknown-route", "admin")).toBe(true);
		expect(isRouteAllowed("/unknown-route", "operator")).toBe(false);
		expect(isRouteAllowed("/unknown-route", "driver")).toBe(false);
	});

	it("rejects missing or unknown roles everywhere, including /", () =>
	{
		for (const role of [null, undefined, "", "customer", "ADMIN"])
		{
			expect(isRouteAllowed("/", role)).toBe(false);
			expect(isRouteAllowed("/orders", role)).toBe(false);
		}
	});
});

describe("isRole()", () =>
{
	it("accepts only the three known roles", () =>
	{
		expect(isRole("admin")).toBe(true);
		expect(isRole("operator")).toBe(true);
		expect(isRole("driver")).toBe(true);
		expect(isRole("customer")).toBe(false);
		expect(isRole(null)).toBe(false);
	});
});
