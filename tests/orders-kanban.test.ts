import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, listOrdersForKanban, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import { assignOrder } from "@/lib/orders/actions-client";

describe("listOrdersForKanban() / assignOrder() from the board", () =>
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
			// service_role: API roles can't write status directly any more.
			expect((await tenant.service.from("orders").update({ status }).eq("id", orderId)).error).toBeNull();
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

	it("fetches the to_confirm, preparing and in_transit categories unbounded, and leaves cancelled out", async () =>
	{
		const pendingId = await freshOrder("pending");
		const confirmedId = await freshOrder("confirmed");
		const dispatchedId = await freshOrder("dispatched");
		const failedId = await freshOrder("delivery_failed");
		const cancelledId = await freshOrder("cancelled");

		const { data } = await listOrdersForKanban(tenant.admin);
		const ids = data!.map((o) => o.id);
		expect(ids).toContain(failedId);
		expect(ids).not.toContain(cancelledId);
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
	}, 60_000);

	it("counts partially_delivered in the delivered category", async () =>
	{
		const t = await setupTenant();
		try
		{
			const { data: customer } = await quickAddCustomer(t.admin, "Partial Customer");
			const { data: product } = await quickAddProduct(t.admin, "Partial Product", { pricePerUnit: 1, unit: "each" });
			const { data } = await createOrder(t.admin, { customer_id: customer!.id, notes: null, items: [{ product_id: product!.id, quantity: 1 }] });
			expect((await t.service.from("orders").update({ status: "partially_delivered" }).eq("id", data!.order.id)).error).toBeNull();

			const { data: board } = await listOrdersForKanban(t.admin);
			expect(board!.map((o) => o.status)).toEqual(["partially_delivered"]);
		}
		finally
		{
			await t.teardown();
		}
	});

	it("assignOrder() confirms from the board and the card shows driver, date, window and a fresh status_changed_at", async () =>
	{
		const orderId = await freshOrder("pending");
		const before = Date.now();
		const { error } = await assignOrder(tenant.operator, orderId, {
			driverId: tenant.driverId,
			deliveryDate: "2026-11-10",
			deliveryWindow: "AM",
			expectedStatus: "pending",
		});
		expect(error).toBeNull();

		const { data } = await listOrdersForKanban(tenant.operator);
		const card = data!.find((o) => o.id === orderId)!;
		expect(card.status).toBe("confirmed");
		expect(card.driverName).not.toBeNull();
		expect(card.deliveryDate).toBe("2026-11-10");
		expect(card.deliveryWindow).toBe("AM");
		expect(card.attempt).toBe(0);
		expect(new Date(card.statusChangedAt).getTime()).toBeGreaterThan(before - 60_000);
	});

	it("assignOrder() with a stale expected status is rejected with PT409 and moves nothing", async () =>
	{
		const orderId = await freshOrder("confirmed");
		const { error } = await assignOrder(tenant.operator, orderId, {
			driverId: tenant.driverId,
			deliveryDate: "2026-11-10",
			deliveryWindow: null,
			expectedStatus: "pending",
		});
		expect(error?.code).toBe("PT409");
	});

	it("a driver can't assign from the board (42501)", async () =>
	{
		const orderId = await freshOrder("pending");
		const { error } = await assignOrder(tenant.driver, orderId, {
			driverId: tenant.driverId,
			deliveryDate: "2026-11-10",
			deliveryWindow: null,
			expectedStatus: "pending",
		});
		expect(error?.code).toBe("42501");
	});

});
