import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/integration/fixtures";
import { createUserInTenant } from "@/lib/users/create-user";
import { createOrder, quickAddCustomer, quickAddProduct, updateOrderDetail } from "@/lib/supabase/queries";

type Client = SupabaseClient<Database>;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service: Client = createClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
	auth: { autoRefreshToken: false, persistSession: false },
});

// Audit columns are written by the database, not by whoever calls the API:
// a direct PostgREST write can't skip them or put a colleague's name on them.
describe("audit columns can't be forged through direct API writes", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let productId: string;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Audit Customer"),
			quickAddProduct(tenant.admin, "Audit Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	async function freshOrder(client: Client = tenant.operator)
	{
		const { data, error } = await createOrder(client, { customer_id: customerId, notes: null, items: [{ product_id: productId, quantity: 1 }] });
		expect(error).toBeNull();
		return { orderId: data!.order.id, itemId: data!.items[0].id };
	}

	async function item(itemId: string)
	{
		const { data } = await service.from("order_items").select("price_at_order, price_overridden_by, price_overridden_at").eq("id", itemId).single();
		return data!;
	}

	it("a direct price PATCH is stamped with the caller, not skipped", async () =>
	{
		const { itemId } = await freshOrder();

		const { error } = await tenant.operator.from("order_items").update({ price_at_order: 7 }).eq("id", itemId);
		expect(error).toBeNull();

		const row = await item(itemId);
		expect(row.price_at_order).toBe(7);
		expect(row.price_overridden_by).toBe(tenant.operatorId);
		expect(row.price_overridden_at).not.toBeNull();
	});

	it("the override can't be attributed to a colleague, with or without a price change", async () =>
	{
		const { itemId } = await freshOrder();

		await tenant.operator.from("order_items")
			.update({ price_at_order: 8, price_overridden_by: tenant.adminId, price_overridden_at: "2020-01-01T00:00:00Z" })
			.eq("id", itemId);
		const afterPrice = await item(itemId);
		expect(afterPrice.price_overridden_by).toBe(tenant.operatorId);
		expect(afterPrice.price_overridden_at).not.toBe("2020-01-01T00:00:00+00:00");

		await tenant.operator.from("order_items").update({ price_overridden_by: tenant.adminId, price_overridden_at: null }).eq("id", itemId);
		expect(await item(itemId)).toEqual(afterPrice);
	});

	async function insertLine(orderId: string, fields: { product_id?: string; price_at_order: number | null; unit_at_order: string | null; price_overridden_by?: string })
	{
		const { data, error } = await tenant.operator.from("order_items")
			.insert({ tenant_id: tenant.tenantId, order_id: orderId, product_id: productId, quantity: 3, price_overridden_at: new Date().toISOString(), ...fields })
			.select("id")
			.single();
		expect(error).toBeNull();
		return data!.id;
	}

	it("a line inserted directly at a non-catalog price is stamped with the caller, never a colleague", async () =>
	{
		const { orderId } = await freshOrder();
		const itemId = await insertLine(orderId, { price_at_order: 1, unit_at_order: "kg", price_overridden_by: tenant.adminId });

		const row = await item(itemId);
		expect(row.price_overridden_by).toBe(tenant.operatorId);
		expect(row.price_overridden_at).not.toBeNull();
	});

	it("a line inserted directly at the catalog price/unit is a snapshot, not an override", async () =>
	{
		const { orderId } = await freshOrder();
		const itemId = await insertLine(orderId, { price_at_order: 10, unit_at_order: "kg", price_overridden_by: tenant.adminId });

		const row = await item(itemId);
		expect(row.price_overridden_by).toBeNull();
		expect(row.price_overridden_at).toBeNull();
	});

	it("a different unit on insert counts as an override", async () =>
	{
		const { orderId } = await freshOrder();
		const itemId = await insertLine(orderId, { price_at_order: 10, unit_at_order: "lb" });
		expect((await item(itemId)).price_overridden_by).toBe(tenant.operatorId);
	});

	it("swapping product_id to a pricier product while keeping the price is stamped", async () =>
	{
		const { data: pricey } = await quickAddProduct(tenant.admin, `Audit Pricey ${randomUUID()}`, { pricePerUnit: 500, unit: "kg" });
		const { itemId } = await freshOrder();

		const { error } = await tenant.operator.from("order_items").update({ product_id: pricey!.id }).eq("id", itemId);
		expect(error).toBeNull();
		expect((await item(itemId)).price_overridden_by).toBe(tenant.operatorId);
	});

	it("changing only unit_at_order is stamped", async () =>
	{
		const { itemId } = await freshOrder();
		await tenant.operator.from("order_items").update({ unit_at_order: "ton" }).eq("id", itemId);
		expect((await item(itemId)).price_overridden_by).toBe(tenant.operatorId);
	});

	it("an existing stamp survives unrelated edits (quantity)", async () =>
	{
		const { itemId } = await freshOrder();
		await tenant.operator.from("order_items").update({ price_at_order: 7 }).eq("id", itemId);
		const stamped = await item(itemId);
		await tenant.admin.from("order_items").update({ quantity: 5 }).eq("id", itemId);
		expect(await item(itemId)).toEqual(stamped);
	});

	it("re-saving the same price through update_order_detail() is not an override", async () =>
	{
		const { orderId, itemId } = await freshOrder();
		const { error } = await updateOrderDetail(tenant.admin, orderId, { priceUpdates: [{ orderItemId: itemId, priceAtOrder: 10 }] });
		expect(error).toBeNull();
		expect((await item(itemId)).price_overridden_by).toBeNull();
	});

	it("orders.created_by is the creator and can't be changed", async () =>
	{
		const { data: inserted, error } = await tenant.operator.from("orders")
			.insert({ tenant_id: tenant.tenantId, customer_id: customerId, created_by: tenant.adminId })
			.select("id, created_by")
			.single();
		expect(error).toBeNull();
		expect(inserted!.created_by).toBe(tenant.operatorId);

		const { orderId } = await freshOrder();
		await tenant.operator.from("orders").update({ created_by: tenant.adminId }).eq("id", orderId);
		await tenant.operator.from("orders").update({ created_by: null }).eq("id", orderId);
		const { data } = await service.from("orders").select("created_by").eq("id", orderId).single();
		expect(data!.created_by).toBe(tenant.operatorId);
	});

	it("created_at is server-owned: can't be backdated on insert or moved on update", async () =>
	{
		const past = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

		// Column privileges (fulfillment locks) now refuse the forged insert outright.
		const { error } = await tenant.operator.from("orders")
			.insert({ tenant_id: tenant.tenantId, customer_id: customerId, created_at: past, updated_at: past });
		expect(error?.code).toBe("42501");

		const { orderId, itemId } = await freshOrder();
		const { data: original } = await service.from("orders").select("created_at").eq("id", orderId).single();
		const { data: originalItem } = await service.from("order_items").select("created_at").eq("id", itemId).single();

		await tenant.operator.from("orders").update({ created_at: past }).eq("id", orderId);
		await tenant.operator.from("order_items").update({ created_at: past }).eq("id", itemId);

		expect((await service.from("orders").select("created_at").eq("id", orderId).single()).data).toEqual(original);
		expect((await service.from("order_items").select("created_at").eq("id", itemId).single()).data).toEqual(originalItem);
	});

	it("backdating can't hide an order from the admin's daily stats", async () =>
	{
		const now = new Date();
		const window = { start: new Date(now.getTime() - 3600_000), end: new Date(now.getTime() + 3600_000) };
		const { orderId } = await freshOrder();
		const stats = async () => (await tenant.admin.rpc("get_today_stats", { p_day_start: window.start.toISOString(), p_day_end: window.end.toISOString() })).data as { orders_today: number };

		const countBefore = (await stats()).orders_today;
		await tenant.operator.from("orders").update({ created_at: "2020-01-01T00:00:00Z" }).eq("id", orderId);
		expect((await stats()).orders_today).toBe(countBefore);
	});

	it("NaN is rejected in price_at_order, quantity and price_per_unit (direct and through the RPC)", async () =>
	{
		const { orderId, itemId } = await freshOrder();

		for (const patch of [{ price_at_order: "NaN" }, { quantity: "NaN" }])
		{
			const { error } = await tenant.operator.from("order_items").update(patch as never).eq("id", itemId);
			expect(error?.code, JSON.stringify(patch)).toBe("23514");
		}
		const { error: productError } = await tenant.operator.from("products").update({ price_per_unit: "NaN" as never }).eq("id", productId);
		expect(productError?.code).toBe("23514");

		const { error: rpcError } = await tenant.operator.rpc("update_order_detail", {
			p_order_id: orderId, p_notes: null as never, p_price_updates: [{ order_item_id: itemId, price_at_order: "NaN" }], p_expected: {},
		});
		expect(rpcError?.code).toBe("23514");

		const { data } = await service.from("order_items").select("price_at_order, quantity").eq("id", itemId).single();
		expect(data).toEqual({ price_at_order: 10, quantity: 1 });
	});

	it("deleting a user still clears their stamps (on delete set null isn't blocked)", async () =>
	{
		const email = `audit+${randomUUID()}@test.nellio.local`;
		const { data: created } = await createUserInTenant(service, {
			tenantId: tenant.tenantId, email, name: "Temp Operator", role: "operator", createdBy: null, password: "Temp-Operator-2026!", mustChangePassword: false,
		});
		const temp = createClient<Database>(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
		expect((await temp.auth.signInWithPassword({ email, password: "Temp-Operator-2026!" })).error).toBeNull();

		const { orderId, itemId } = await freshOrder(temp);
		await temp.from("order_items").update({ price_at_order: 9 }).eq("id", itemId);
		expect((await item(itemId)).price_overridden_by).toBe(created!.id);

		const { error } = await service.auth.admin.deleteUser(created!.id);
		expect(error).toBeNull();

		expect((await item(itemId)).price_overridden_by).toBeNull();
		const { data: order } = await service.from("orders").select("created_by").eq("id", orderId).single();
		expect(order!.created_by).toBeNull();
	});
});
