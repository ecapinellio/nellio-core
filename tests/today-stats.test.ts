import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, getTodayStats, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

describe("getTodayStats() / get_today_stats() RPC", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let pricedProductId: string;
	let unpricedProductId: string;

	// Local-time boundary, matching get_today_stats()'s own half-open
	// [day_start, day_end) interval — not UTC, same convention as
	// checkPendingDuplicateOrder()'s existing day-boundary tests.
	const NOW = new Date(2026, 0, 15, 10, 0, 0);
	const DAY_START = new Date(2026, 0, 15, 0, 0, 0);
	const DAY_END = new Date(2026, 0, 16, 0, 0, 0);
	const YESTERDAY = new Date(2026, 0, 14, 23, 59, 59);

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer }, { data: pricedProduct }, { data: unpricedProduct }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Stats Test Customer"),
			quickAddProduct(tenant.admin, "Stats Test Priced Product", { pricePerUnit: 10, unit: "kg" }),
			quickAddProduct(tenant.admin, "Stats Test Unpriced Product"),
		]);
		customerId = customer!.id;
		pricedProductId = pricedProduct!.id;
		unpricedProductId = unpricedProduct!.id;
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	/**
	 * Stats aggregate over the WHOLE tenant (not scoped to one customer like
	 * checkPendingDuplicateOrder's tests), so today/boundary/zero-orders
	 * tests each get their own fresh tenant via setupTenant() rather than
	 * sharing one — otherwise they'd pollute each other's counts. Only the
	 * sales/unpriced and role-rejection tests reuse the outer `tenant`,
	 * since they don't assert exact counts.
	 */
	async function insertOrderAt(t: TestTenant, customer: string, product: string, createdAt: Date, status: string, qty = 1)
	{
		const { data: order, error } = await t.admin
			.from("orders")
			.insert({ tenant_id: t.tenantId, customer_id: customer, notes: "stats fixture", status, created_at: createdAt.toISOString() })
			.select()
			.single();
		if (error)
		{
			throw new Error(`fixture order insert failed: ${error.message}`);
		}
		const { data: productRow } = await t.admin.from("products").select("price_per_unit, unit").eq("id", product).single();
		// tenant_id here is immediately overwritten by the
		// set_order_item_tenant_id trigger (core_schema.sql) — included only
		// because the generated Insert type marks the column required; the
		// trigger is the actual source of truth, not this value.
		await t.admin.from("order_items").insert({
			tenant_id: t.tenantId,
			order_id: order.id,
			product_id: product,
			quantity: qty,
			price_at_order: productRow!.price_per_unit,
			unit_at_order: productRow!.unit,
		});
		return order.id;
	}

	it("counts orders/pending/delivered scoped to today, excludes yesterday", async () =>
	{
		const t = await setupTenant();
		try
		{
			const { data: customer } = await quickAddCustomer(t.admin, "Scoped Customer");
			const { data: product } = await quickAddProduct(t.admin, "Scoped Product", { pricePerUnit: 10, unit: "kg" });

			await insertOrderAt(t, customer!.id, product!.id, NOW, "pending");
			await insertOrderAt(t, customer!.id, product!.id, NOW, "delivered");
			await insertOrderAt(t, customer!.id, product!.id, NOW, "confirmed");
			await insertOrderAt(t, customer!.id, product!.id, YESTERDAY, "pending");

			const { data, error } = await getTodayStats(t.admin, DAY_START, DAY_END);
			expect(error).toBeNull();
			expect(data?.ordersToday).toBe(3);
			expect(data?.pendingToday).toBe(1);
			expect(data?.deliveredToday).toBe(1);
		}
		finally
		{
			await t.teardown();
		}
	});

	it("half-open interval: an order at exactly day_start is included, at exactly day_end is excluded", async () =>
	{
		const t = await setupTenant();
		try
		{
			const { data: customer } = await quickAddCustomer(t.admin, "Boundary Customer");
			const { data: product } = await quickAddProduct(t.admin, "Boundary Product", { pricePerUnit: 10, unit: "kg" });

			await insertOrderAt(t, customer!.id, product!.id, DAY_START, "pending");
			await insertOrderAt(t, customer!.id, product!.id, DAY_END, "pending"); // next day's start

			const { data } = await getTodayStats(t.admin, DAY_START, DAY_END);
			expect(data?.ordersToday).toBe(1);
		}
		finally
		{
			await t.teardown();
		}
	});

	it("returns zeros, not null, for a day with no orders", async () =>
	{
		const t = await setupTenant();
		try
		{
			const farFuture = new Date(2099, 0, 1);
			const farFutureEnd = new Date(2099, 0, 2);
			const { data, error } = await getTodayStats(t.admin, farFuture, farFutureEnd);
			expect(error).toBeNull();
			expect(data).toEqual({ ordersToday: 0, pendingToday: 0, deliveredToday: 0, salesToday: 0, unpricedCount: 0 });
		}
		finally
		{
			await t.teardown();
		}
	});

	it("sales_today sums only priced lines; unpriced_count counts the rest", async () =>
	{
		const { data: order } = await tenant.admin
			.from("orders")
			.insert({ tenant_id: tenant.tenantId, customer_id: customerId, notes: "mixed", status: "pending", created_at: NOW.toISOString() })
			.select()
			.single();
		await tenant.admin.from("order_items").insert([
			{ tenant_id: tenant.tenantId, order_id: order!.id, product_id: pricedProductId, quantity: 2, price_at_order: 10, unit_at_order: "kg" }, // 2*10=20
			{ tenant_id: tenant.tenantId, order_id: order!.id, product_id: unpricedProductId, quantity: 5, price_at_order: null, unit_at_order: null },
		]);

		const { data } = await getTodayStats(tenant.admin, DAY_START, DAY_END);
		expect(data?.salesToday).toBe(20);
		expect(data?.unpricedCount).toBe(1);
	});

	it("operator is explicitly rejected with 42501 — not silently zeroed (eng-review Decision 2, REVISED)", async () =>
	{
		const { error } = await getTodayStats(tenant.operator, DAY_START, DAY_END);
		expect(error?.code).toBe("42501");
	});

	it("driver is explicitly rejected with 42501", async () =>
	{
		const { error } = await getTodayStats(tenant.driver, DAY_START, DAY_END);
		expect(error?.code).toBe("42501");
	});

	it("happy path via createOrder() end to end (not just direct inserts)", async () =>
	{
		const t = await setupTenant();
		try
		{
			const { data: customer } = await quickAddCustomer(t.admin, "E2E Customer");
			const { data: product } = await quickAddProduct(t.admin, "E2E Product", { pricePerUnit: 15, unit: "l" });
			await createOrder(t.admin, {
				customer_id: customer!.id,
				notes: "e2e",
				items: [{ product_id: product!.id, quantity: 3 }],
			});

			const now = new Date();
			const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const dayEnd = new Date(dayStart);
			dayEnd.setDate(dayEnd.getDate() + 1);

			const { data, error } = await getTodayStats(t.admin, dayStart, dayEnd);
			expect(error).toBeNull();
			expect(data?.ordersToday).toBe(1);
			expect(data?.salesToday).toBe(45);
		}
		finally
		{
			await t.teardown();
		}
	});
});
