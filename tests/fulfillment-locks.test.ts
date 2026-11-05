import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct, updateOrderDetail } from "@/lib/supabase/queries";

describe("direct writes closed and edit lock", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let productId: string;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Locks Customer"),
			quickAddProduct(tenant.admin, "Locks Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	async function freshOrder()
	{
		const { data } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "n",
			items: [{ product_id: productId, quantity: 2 }],
		});
		return { orderId: data!.order.id, itemId: data!.items[0].id };
	}

	async function setStatus(orderId: string, status: string)
	{
		const { error } = await tenant.service.from("orders").update({ status }).eq("id", orderId);
		expect(error).toBeNull();
	}

	it("operator cannot change status, driver_id, invoice_status or status_changed_at directly", async () =>
	{
		const { orderId } = await freshOrder();
		const patches = [
			{ status: "delivered" },
			{ driver_id: tenant.driverId },
			{ invoice_status: "issued" },
			{ status_changed_at: new Date().toISOString() },
		];
		for (const client of [tenant.operator, tenant.admin])
		{
			for (const patch of patches)
			{
				const { error } = await client.from("orders").update(patch).eq("id", orderId);
				expect(error?.code, JSON.stringify(patch)).toBe("42501");
			}
		}
	});

	it("operator cannot insert an order with a status or driver", async () =>
	{
		const base = { tenant_id: tenant.tenantId, customer_id: customerId };
		const a = await tenant.operator.from("orders").insert({ ...base, status: "delivered" });
		expect(a.error?.code).toBe("42501");
		const b = await tenant.operator.from("orders").insert({ ...base, driver_id: tenant.driverId });
		expect(b.error?.code).toBe("42501");
	});

	it("operator cannot write delivered_quantity directly", async () =>
	{
		const { itemId } = await freshOrder();
		const { error } = await tenant.operator.from("order_items").update({ delivered_quantity: 1 }).eq("id", itemId);
		expect(error?.code).toBe("42501");
	});

	it("edits allowed until accepted, rejected from in_transit on", async () =>
	{
		const { orderId, itemId } = await freshOrder();
		await setStatus(orderId, "accepted");
		const ok = await updateOrderDetail(tenant.operator, orderId, { notes: "still editable", priceUpdates: [] });
		expect(ok.error).toBeNull();

		for (const status of ["dispatched", "delivered", "cancelled"])
		{
			await setStatus(orderId, status);
			const res = await updateOrderDetail(tenant.operator, orderId, { notes: "locked", priceUpdates: [] });
			expect(res.error?.code, status).toBe("22023");
			const price = await updateOrderDetail(tenant.operator, orderId, {
				priceUpdates: [{ orderItemId: itemId, priceAtOrder: 99 }],
			});
			expect(price.error?.code, status).toBe("22023");
		}

		await setStatus(orderId, "dispatched");
		const ins = await tenant.operator
			.from("order_items")
			.insert({ order_id: orderId, product_id: productId, quantity: 1, tenant_id: tenant.tenantId });
		expect(ins.error?.code).toBe("22023");
		// No DELETE policy on order_items: nothing is deleted (the trigger is a second wall).
		const del = await tenant.operator.from("order_items").delete().eq("id", itemId).select();
		expect(del.data ?? []).toEqual([]);
	});

	it("editing an item bumps the order's updated_at", async () =>
	{
		const { orderId, itemId } = await freshOrder();
		const { data: before } = await tenant.service.from("orders").select("updated_at").eq("id", orderId).single();
		await new Promise((r) => setTimeout(r, 20));
		const { error } = await tenant.operator.from("order_items").update({ quantity: 5 }).eq("id", itemId);
		expect(error).toBeNull();
		const { data } = await tenant.service.from("orders").select("updated_at").eq("id", orderId).single();
		expect(new Date(data!.updated_at).getTime()).toBeGreaterThan(new Date(before!.updated_at).getTime());
	});
});
