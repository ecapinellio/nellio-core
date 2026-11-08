import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/integration/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

const ECTEC = [
	["pending", "Pedido", "to_confirm", "created", 1],
	["confirmed", "Confirmado", "preparing", "confirmed", 2],
	["accepted", "Aceptado por chofer", "preparing", "accepted", 3],
	["dispatched", "En camino", "in_transit", "picked_up", 4],
	["delivery_failed", "Entrega fallida", "in_transit", "delivery_failed", 5],
	["delivered", "Entregado", "delivered", "delivered", 6],
	["partially_delivered", "Entregado parcial", "delivered", "partially_delivered", 7],
	["cancelled", "Cancelado", "cancelled", "cancelled", 8],
] as const;

describe("fulfillment model", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let orderId: string;

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: c }, { data: p }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Fulfillment Customer"),
			quickAddProduct(tenant.admin, "Fulfillment Product"),
		]);
		const { data, error } = await createOrder(tenant.operator, {
			customer_id: c!.id,
			notes: "x",
			items: [{ product_id: p!.id, quantity: 2 }],
		});
		expect(error).toBeNull();
		orderId = data!.order.id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	it("seeds the 8 ECTEC statuses and default settings for a new tenant", async () =>
	{
		const { data } = await tenant.admin.from("order_statuses").select().order("position");
		expect(data!.map((s) => [s.key, s.label, s.category, s.step, s.position])).toEqual(ECTEC.map((r) => [...r]));

		const { data: settings } = await tenant.admin.from("tenant_order_settings").select().single();
		expect(settings).toMatchObject({
			require_driver_acceptance: true,
			require_signature: true,
			require_receiver_name: true,
			require_photo: false,
		});
	});

	it("a new order starts in the created step and logs a create event", async () =>
	{
		const { data: order } = await tenant.admin.from("orders").select().eq("id", orderId).single();
		expect(order).toMatchObject({ status: "pending", invoice_status: "not_invoiced", driver_id: null });

		const { data: events } = await tenant.admin.from("order_events").select().eq("order_id", orderId);
		expect(events).toHaveLength(1);
		expect(events![0]).toMatchObject({ action: "create", to_status: "pending", actor_id: tenant.operatorId });
	});

	it("status must exist for the tenant", async () =>
	{
		const { error } = await tenant.service.from("orders").update({ status: "nope" }).eq("id", orderId);
		expect(error?.code).toBe("23503");
	});

	it("order_category and order_status_for_step resolve per tenant", async () =>
	{
		const { data: cat } = await tenant.service.rpc("order_category", { p_tenant_id: tenant.tenantId, p_status: "dispatched" });
		expect(cat).toBe("in_transit");
		const { data: key } = await tenant.service.rpc("order_status_for_step", { p_tenant_id: tenant.tenantId, p_step: "picked_up" });
		expect(key).toBe("dispatched");
		const { error } = await tenant.service.rpc("order_status_for_step", { p_tenant_id: tenant.tenantId, p_step: "bogus" });
		expect(error?.code).toBe("22023");
	});

	it("no role can write statuses, settings or events directly", async () =>
	{
		for (const client of [tenant.admin, tenant.operator])
		{
			const a = await client.from("order_statuses").insert({ tenant_id: tenant.tenantId, key: "x", label: "X", category: "preparing", position: 9 }).select();
			expect(a.error || a.data?.length === 0).toBeTruthy();
			const b = await client.from("order_statuses").update({ label: "Hacked" }).eq("key", "pending").select();
			expect(b.error || b.data?.length === 0).toBeTruthy();
			const c = await client.from("tenant_order_settings").update({ require_photo: true }).eq("tenant_id", tenant.tenantId).select();
			expect(c.error || c.data?.length === 0).toBeTruthy();
			const d = await client.from("order_events").insert({ tenant_id: tenant.tenantId, order_id: orderId, action: "cancel", to_status: "cancelled" }).select();
			expect(d.error || d.data?.length === 0).toBeTruthy();
			const e = await client.from("order_events").update({ note: "x" }).eq("order_id", orderId).select();
			expect(e.error || e.data?.length === 0).toBeTruthy();
		}
		const { data } = await tenant.service.from("tenant_order_settings").select().eq("tenant_id", tenant.tenantId).single();
		expect(data!.require_photo).toBe(false);
	});

	it("driver cannot read order_events; other tenant sees nothing", async () =>
	{
		const d = await tenant.driver.from("order_events").select();
		expect(d.data ?? []).toHaveLength(0);
		const o = await other.admin.from("order_events").select().eq("order_id", orderId);
		expect(o.data ?? []).toHaveLength(0);
		const s = await tenant.driver.from("order_statuses").select();
		expect(s.data).toHaveLength(8);
		const os = await other.admin.from("order_statuses").select().eq("tenant_id", tenant.tenantId);
		expect(os.data ?? []).toHaveLength(0);
	});

	it("deleting an assigned driver nulls orders.driver_id and keeps the order", async () =>
	{
		const t = await setupTenant();
		try
		{
			const { data: c } = await quickAddCustomer(t.admin, "Driver Delete Customer");
			const { data: p } = await quickAddProduct(t.admin, "Driver Delete Product");
			const { data } = await createOrder(t.operator, { customer_id: c!.id, notes: "x", items: [{ product_id: p!.id, quantity: 1 }] });
			const id = data!.order.id;
			const up = await t.service.from("orders").update({ driver_id: t.driverId }).eq("id", id);
			expect(up.error).toBeNull();

			const del = await t.service.auth.admin.deleteUser(t.driverId);
			expect(del.error).toBeNull();

			const { data: order } = await t.service.from("orders").select("driver_id, tenant_id").eq("id", id).single();
			expect(order).toMatchObject({ driver_id: null, tenant_id: t.tenantId });
		}
		finally
		{
			await t.teardown();
		}
	});
});
