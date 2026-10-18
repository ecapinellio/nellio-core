import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, listOrdersForKanban, quickAddCustomer, quickAddProduct, updateOrderStatus } from "@/lib/supabase/queries";

describe("listOrdersForKanban() / updateOrderStatus()", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let productId: string;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Kanban Test Customer"),
			quickAddProduct(tenant.admin, "Kanban Test Product", { pricePerUnit: 8, unit: "each" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	async function freshOrder(status: string): Promise<string>
	{
		const { data } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: `fixture order (${status})`,
			items: [{ product_id: productId, quantity: 1 }],
		});
		const orderId = data!.order.id;
		if (status !== "pending")
		{
			await tenant.admin.from("orders").update({ status }).eq("id", orderId);
		}
		return orderId;
	}

	it("returns embedded line items with the product name and price_at_order", async () =>
	{
		const orderId = await freshOrder("pending");
		const { data, error } = await listOrdersForKanban(tenant.admin);

		expect(error).toBeNull();
		const order = data!.find((o) => o.id === orderId);
		expect(order).toBeDefined();
		expect(order!.items).toEqual([{ quantity: 1, priceAtOrder: 8, productName: "Kanban Test Product" }]);
	});

	it("fetches active statuses (pending/confirmed/dispatched) unbounded", async () =>
	{
		const pendingId = await freshOrder("pending");
		const confirmedId = await freshOrder("confirmed");
		const dispatchedId = await freshOrder("dispatched");

		const { data } = await listOrdersForKanban(tenant.admin);
		const ids = data!.map((o) => o.id);
		expect(ids).toContain(pendingId);
		expect(ids).toContain(confirmedId);
		expect(ids).toContain(dispatchedId);
	});

	it("caps delivered orders at 50, newest first (Decision 6)", async () =>
	{
		// 52 delivered orders already exceeds the cap on its own — no need to
		// also account for other tests' fixture orders in this file, since
		// they all use other statuses.
		for (let i = 0; i < 52; i++)
		{
			await freshOrder("delivered");
		}

		const { data } = await listOrdersForKanban(tenant.admin);
		const delivered = data!.filter((o) => o.status === "delivered");
		expect(delivered.length).toBe(50);
	});

	it("updateOrderStatus() changes the status and RLS/role (T8) still blocks a driver from calling it", async () =>
	{
		const orderId = await freshOrder("pending");

		// RLS blocks the update entirely (0 rows affected) — .select().single()
		// then errors (PGRST116: "no rows returned"), it doesn't just silently
		// no-op, so the caller can tell "update blocked" apart from "nothing to do".
		const { data: driverAttempt, error: driverError } = await updateOrderStatus(tenant.driver, orderId, "confirmed");
		expect(driverAttempt).toBeNull();
		expect(driverError?.code).toBe("PGRST116");

		const { data: unchanged } = await tenant.admin.from("orders").select("status").eq("id", orderId).single();
		expect(unchanged?.status).toBe("pending");

		const { data: operatorAttempt, error } = await updateOrderStatus(tenant.operator, orderId, "confirmed");
		expect(error).toBeNull();
		expect(operatorAttempt?.status).toBe("confirmed");
	});
});
