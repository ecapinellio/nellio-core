import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import {
	checkPendingDuplicateOrder,
	quickAddCustomer,
	quickAddProduct,
	searchCustomers,
	searchProducts,
} from "@/lib/supabase/queries";

describe("query helpers", () =>
{
	let tenant: TestTenant;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	describe("quickAddCustomer / quickAddProduct", () =>
	{
		it("creates a row scoped to the caller's own tenant", async () =>
		{
			const { data, error } = await quickAddCustomer(tenant.admin, "Ferretería Progreso");
			expect(error).toBeNull();
			expect(data?.name).toBe("Ferretería Progreso");
			expect(data?.tenant_id).toBe(tenant.tenantId);
		});

		it("rejects a blank name", async () =>
		{
			const { error } = await quickAddCustomer(tenant.admin, "   ");
			expect(error?.code).toBe("22004");
		});

		it("quickAddProduct creates a row scoped to the caller's own tenant, price/unit nullable by default", async () =>
		{
			const { data, error } = await quickAddProduct(tenant.admin, "Cloro 5L");
			expect(error).toBeNull();
			expect(data?.name).toBe("Cloro 5L");
			expect(data?.tenant_id).toBe(tenant.tenantId);
			expect(data?.price_per_unit).toBeNull();
			expect(data?.unit).toBeNull();
		});

		it("quickAddProduct rejects a blank name", async () =>
		{
			const { error } = await quickAddProduct(tenant.admin, "");
			expect(error?.code).toBe("22004");
		});

		it("quickAddProduct accepts price_per_unit and unit together", async () =>
		{
			const { data, error } = await quickAddProduct(tenant.admin, "Ácido Sulfúrico", {
				pricePerUnit: 45.5,
				unit: "l",
			});
			expect(error).toBeNull();
			expect(data?.price_per_unit).toBe(45.5);
			expect(data?.unit).toBe("l");
		});

		it("quickAddProduct rejects price_per_unit <= 0 (RPC-level check)", async () =>
		{
			const { error } = await quickAddProduct(tenant.admin, "Negative Price Product", {
				pricePerUnit: 0,
				unit: "kg",
			});
			expect(error?.code).toBe("22003");
		});

		it("quickAddProduct rejects a unit outside the fixed list", async () =>
		{
			const { error } = await quickAddProduct(tenant.admin, "Bad Unit Product", {
				// @ts-expect-error -- deliberately outside the ProductUnit union
				unit: "barrels",
				pricePerUnit: 10,
			});
			expect(error?.code).toBe("23514"); // check_violation
		});

		it("a direct update bypassing the RPC cannot set a non-positive price (table-level check, Decision 9)", async () =>
		{
			const { data: product } = await quickAddProduct(tenant.admin, "Direct Update Target", {
				pricePerUnit: 10,
				unit: "kg",
			});
			const { error } = await tenant.admin
				.from("products")
				.update({ price_per_unit: -5 })
				.eq("id", product!.id);
			expect(error?.code).toBe("23514");
		});
	});

	describe("searchCustomers / searchProducts", () =>
	{
		beforeAll(async () =>
		{
			await quickAddCustomer(tenant.admin, "Química Industrial S.A.");
			await quickAddProduct(tenant.admin, "Ácido Muriático", { pricePerUnit: 12.75, unit: "gal" });
		});

		it("searchProducts returns price_per_unit and unit (select p.* flows through, no RPC change needed)", async () =>
		{
			const { data } = await searchProducts(tenant.admin, "Acido Muriatico");
			const match = data?.find((p) => p.name === "Ácido Muriático");
			expect(match?.price_per_unit).toBe(12.75);
			expect(match?.unit).toBe("gal");
		});

		it("empty query returns a browse list, not an error", async () =>
		{
			const { data, error } = await searchCustomers(tenant.admin, "");
			expect(error).toBeNull();
			expect(data?.length).toBeGreaterThan(0);
		});

		it("matches accent-insensitively", async () =>
		{
			const { data, error } = await searchCustomers(tenant.admin, "Quimica Industrial");
			expect(error).toBeNull();
			expect(data?.some((c) => c.name === "Química Industrial S.A.")).toBe(true);
		});

		it("products also match accent-insensitively", async () =>
		{
			const { data, error } = await searchProducts(tenant.admin, "Acido Muriatico");
			expect(error).toBeNull();
			expect(data?.some((p) => p.name === "Ácido Muriático")).toBe(true);
		});

		it("returns an empty array, not an error, for no match", async () =>
		{
			const { data, error } = await searchCustomers(tenant.admin, "zzz-no-such-customer-zzz");
			expect(error).toBeNull();
			expect(data).toEqual([]);
		});
	});

	describe("checkPendingDuplicateOrder", () =>
	{
		// Local-time boundary, matching checkPendingDuplicateOrder's own
		// getFullYear/Month/Date construction — not UTC.
		const NOW = new Date(2026, 0, 15, 10, 0, 0);
		const SAME_DAY = new Date(2026, 0, 15, 0, 0, 1);
		const PREVIOUS_DAY = new Date(2026, 0, 14, 23, 59, 59);

		// orders has no DELETE policy (T2: "deletion is an explicit future
		// decision") — a direct .delete() silently matches zero rows under
		// RLS instead of erroring. Each case gets its own fresh customer
		// instead of reusing+"cleaning up" one, so there is nothing to delete
		// and no cross-test contamination; tenant teardown cascades it all
		// away at the end regardless.
		async function freshCustomerWithOrder(status: string, createdAt: Date)
		{
			const { data: customer } = await quickAddCustomer(tenant.admin, `Dedup Test ${crypto.randomUUID()}`);
			const { data: order, error } = await tenant.admin
				.from("orders")
				.insert({
					tenant_id: tenant.tenantId,
					customer_id: customer!.id,
					notes: "fixture order",
					status,
					created_at: createdAt.toISOString(),
				})
				.select()
				.single();
			if (error)
			{
				throw new Error(`fixture insert failed: ${error.message}`);
			}
			return { customerId: customer!.id, order };
		}

		it("no existing order → no duplicate", async () =>
		{
			const { data: customer } = await quickAddCustomer(tenant.admin, `No Orders ${crypto.randomUUID()}`);
			const result = await checkPendingDuplicateOrder(tenant.admin, customer!.id, NOW);
			expect(result).toEqual({ status: "ok", duplicate: null });
		});

		it("pending order same day → flagged as duplicate", async () =>
		{
			const { customerId, order } = await freshCustomerWithOrder("pending", SAME_DAY);
			const result = await checkPendingDuplicateOrder(tenant.admin, customerId, NOW);
			expect(result.status).toBe("ok");
			expect(result.status === "ok" && result.duplicate?.id).toBe(order.id);
		});

		it.each(["confirmed", "dispatched", "delivered"])(
			"%s order same day → NOT flagged (status-aware)",
			async (status) =>
			{
				const { customerId } = await freshCustomerWithOrder(status, SAME_DAY);
				const result = await checkPendingDuplicateOrder(tenant.admin, customerId, NOW);
				expect(result).toEqual({ status: "ok", duplicate: null });
			},
		);

		it("pending order from the previous day → NOT flagged (day boundary)", async () =>
		{
			const { customerId } = await freshCustomerWithOrder("pending", PREVIOUS_DAY);
			const result = await checkPendingDuplicateOrder(tenant.admin, customerId, NOW);
			expect(result).toEqual({ status: "ok", duplicate: null });
		});

		it("malformed customerId fails open", async () =>
		{
			const result = await checkPendingDuplicateOrder(tenant.admin, "not-a-uuid", NOW);
			expect(result.status).toBe("check_failed");
		});
	});
});
