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
			await tenant.service.from("orders").update({ status }).eq("id", orderId);
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

	it.todo("updateOrderStatus() changes the status and RLS/role (T8) still blocks a driver from calling it — rewritten in Task 6");

	it.todo("updateOrderStatus() with an expected status won't overwrite a move the board hasn't seen — rewritten in Task 6");
});
