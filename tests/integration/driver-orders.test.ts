import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/integration/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

type Row = { id: string } & Record<string, unknown>;

const PASSWORD = "Nellio-Test-Pass-2026!";

describe("driver orders", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let productId: string;
	let driver2: ReturnType<typeof createClient<Database>>;
	let driver2Id: string;
	const date = "2026-11-10";

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer, error: ce }, { data: product, error: pe }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Driver Customer"),
			quickAddProduct(tenant.admin, "Driver Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		expect(ce).toBeNull();
		expect(pe).toBeNull();
		customerId = customer!.id;
		productId = product!.id;
		const up = await tenant.service.from("customers").update({ address: "Calle 1", phone: "7000-0000" }).eq("id", customerId);
		expect(up.error).toBeNull();

		const email = `d2-${crypto.randomUUID()}@test.local`;
		const { data: u, error } = await tenant.service.auth.admin.createUser({
			email, password: PASSWORD, email_confirm: true,
			app_metadata: { tenant_id: tenantIdOf(), role: "driver" },
		});
		expect(error).toBeNull();
		driver2Id = u.user!.id;
		const ins = await tenant.service.from("users").insert({ id: driver2Id, tenant_id: tenantIdOf(), name: "D2", role: "driver" });
		expect(ins.error).toBeNull();
		driver2 = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
			auth: { autoRefreshToken: false, persistSession: false },
		});
		const si = await driver2.auth.signInWithPassword({ email, password: PASSWORD });
		expect(si.error).toBeNull();
	});

	function tenantIdOf()
	{
		return tenant.tenantId;
	}

	afterAll(async () =>
	{
		await tenant.service.auth.admin.deleteUser(driver2Id);
		await tenant.teardown();
	});

	/** An order assigned to `driver` (confirmed), via the real office RPC. */
	async function assigned(driver = tenant.driverId, qty = 2)
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId, notes: "n", items: [{ product_id: productId, quantity: qty }],
		});
		expect(error).toBeNull();
		const id = data!.order.id;
		const r = await tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: driver, p_delivery_date: date, p_delivery_window: "AM", p_expected_status: "pending",
		});
		expect(r.error).toBeNull();
		return id;
	}

	const respond = (c: TestTenant["driver"], id: string, accept: boolean, expected = "confirmed") =>
		c.rpc("respond_to_assignment", { p_order_id: id, p_accept: accept, p_expected_status: expected });

	async function statusOf(id: string)
	{
		const { data, error } = await tenant.service.from("orders").select("status, driver_id").eq("id", id).single();
		expect(error).toBeNull();
		return data!;
	}

	it("driver sees only orders assigned to them", async () =>
	{
		const mine = await assigned(tenant.driverId);
		const theirs = await assigned(driver2Id);

		const { data: rows } = await tenant.driver.from("orders").select("id");
		const ids = rows!.map((r) => r.id);
		expect(ids).toContain(mine);
		expect(ids).not.toContain(theirs);

		const { data: list, error } = await tenant.driver.rpc("list_driver_orders");
		expect(error).toBeNull();
		const listIds = (list as Row[]).map((o) => o.id);
		expect(listIds).toContain(mine);
		expect(listIds).not.toContain(theirs);

		// An order not yet assigned to anyone is invisible too.
		const { data: o } = await createOrder(tenant.admin, { customer_id: customerId, notes: "n", items: [{ product_id: productId, quantity: 1 }] });
		expect((await tenant.driver.from("orders").select("id").eq("id", o!.order.id)).data).toEqual([]);
	});

	it("driver list has customer address/phone and total, no line prices", async () =>
	{
		const id = await assigned(tenant.driverId, 3);
		const { data } = await tenant.driver.rpc("list_driver_orders");
		const order = (data as (Row & { items: Row[] })[]).find((o) => o.id === id)!;
		expect(order).toMatchObject({
			status: "confirmed", category: "preparing", delivery_date: date, delivery_window: "AM", attempt: 0,
			customer: { name: "Driver Customer", address: "Calle 1", phone: "7000-0000" },
		});
		expect(Number(order.total)).toBe(30);
		expect(order.items).toHaveLength(1);
		expect(order.items[0]).toMatchObject({ product_name: "Driver Product", unit: "kg", delivered_quantity: null });
		expect(Number(order.items[0].quantity)).toBe(3);
		expect(order.items[0]).not.toHaveProperty("price_at_order");
	});

	it("closed orders stay visible 7 days", async () =>
	{
		const id = await assigned();
		const set = (d: number) => tenant.service.from("orders")
			.update({ status: "delivered", status_changed_at: new Date(Date.now() - d * 86400_000).toISOString() }).eq("id", id);
		expect((await set(6)).error).toBeNull();
		expect((await tenant.driver.from("orders").select("id").eq("id", id)).data).toHaveLength(1);
		expect(((await tenant.driver.rpc("list_driver_orders")).data as Row[]).some((o) => o.id === id)).toBe(true);

		expect((await set(8)).error).toBeNull();
		expect((await tenant.driver.from("orders").select("id").eq("id", id)).data).toEqual([]);
		expect(((await tenant.driver.rpc("list_driver_orders")).data as Row[]).some((o) => o.id === id)).toBe(false);
	});

	it("driver still cannot read customers or order_items directly", async () =>
	{
		await assigned();
		expect((await tenant.driver.from("customers").select("id")).data).toEqual([]);
		expect((await tenant.driver.from("order_items").select("id")).data).toEqual([]);
	});

	it("non-drivers cannot use the driver functions", async () =>
	{
		const id = await assigned();
		expect((await tenant.operator.rpc("list_driver_orders")).error?.code).toBe("42501");
		expect((await respond(tenant.operator, id, true)).error?.code).toBe("42501");
		expect((await tenant.operator.rpc("pick_up_orders", { p_order_ids: [id] })).error?.code).toBe("42501");
	});

	it("accept → accepted; reject → confirmed without driver, operator sees reject event", async () =>
	{
		const a = await assigned();
		const acc = await respond(tenant.driver, a, true);
		expect(acc.error).toBeNull();
		expect(acc.data).toMatchObject({ status: "accepted", driver_id: tenant.driverId });
		// Cannot respond twice.
		expect((await respond(tenant.driver, a, true)).error?.code).toBe("PT409");
		expect((await respond(tenant.driver, a, true, "accepted")).error?.code).toBe("22023");

		const r = await assigned();
		const rej = await respond(tenant.driver, r, false);
		expect(rej.error).toBeNull();
		expect(rej.data).toMatchObject({ status: "confirmed", driver_id: null });
		const { data: ev } = await tenant.operator.from("order_events").select("*").eq("order_id", r).eq("action", "reject");
		expect(ev).toHaveLength(1);
		expect(ev![0].payload).toMatchObject({ driver_id: tenant.driverId });
		expect(ev![0].actor_id).toBe(tenant.driverId);
		// It left the driver's view.
		expect((await tenant.driver.from("orders").select("id").eq("id", r)).data).toEqual([]);
		const { data: accEv } = await tenant.operator.from("order_events").select("id").eq("order_id", a).eq("action", "accept");
		expect(accEv).toHaveLength(1);
	});

	it("a driver cannot respond for another driver's order", async () =>
	{
		const id = await assigned(driver2Id);
		expect((await respond(tenant.driver, id, true)).error?.code).toBe("P0002");
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error?.code).toBe("P0002");
		expect((await statusOf(id)).status).toBe("confirmed");
		expect((await respond(tenant.driver, crypto.randomUUID(), true)).error?.code).toBe("P0002");
	});

	it("pick up several at once, all or nothing", async () =>
	{
		const [a, b, c] = [await assigned(), await assigned(), await assigned()];
		for (const id of [a, b])
		{
			expect((await respond(tenant.driver, id, true)).error).toBeNull();
		}
		// c was never accepted: nothing moves.
		const bad = await tenant.driver.rpc("pick_up_orders", { p_order_ids: [a, b, c] });
		expect(bad.error?.code).toBe("22023");
		expect((await statusOf(a)).status).toBe("accepted");
		expect((await statusOf(b)).status).toBe("accepted");

		const ok = await tenant.driver.rpc("pick_up_orders", { p_order_ids: [b, a, a] });
		expect(ok.error).toBeNull();
		expect(ok.data).toHaveLength(2);
		expect((await statusOf(a)).status).toBe("dispatched");
		expect((await statusOf(b)).status).toBe("dispatched");
		const { data: ev } = await tenant.operator.from("order_events").select("id").eq("order_id", a).eq("action", "pick_up");
		expect(ev).toHaveLength(1);
		const list = (await tenant.driver.rpc("list_driver_orders")).data as Row[];
		expect(list.find((o) => o.id === a)).toMatchObject({ category: "in_transit", attempt: 1 });

		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [] })).error?.code).toBe("22023");
	});

	it("pick up without acceptance when the tenant turns it off", async () =>
	{
		const id = await assigned();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error?.code).toBe("22023");
		try
		{
			const s = await tenant.service.from("tenant_order_settings").update({ require_driver_acceptance: false }).eq("tenant_id", tenant.tenantId);
			expect(s.error).toBeNull();
			const r = await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] });
			expect(r.error).toBeNull();
			expect((await statusOf(id)).status).toBe("dispatched");
		}
		finally
		{
			const s = await tenant.service.from("tenant_order_settings").update({ require_driver_acceptance: true }).eq("tenant_id", tenant.tenantId);
			expect(s.error).toBeNull();
		}
	});

	it("pick up of an order cancelled meanwhile is rejected", async () =>
	{
		const id = await assigned();
		expect((await respond(tenant.driver, id, true)).error).toBeNull();
		const c = await tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: "customer_closed", p_note: "", p_expected_status: "accepted" });
		expect(c.error).toBeNull();
		const r = await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] });
		expect(["PT409", "22023"]).toContain(r.error?.code);
		expect((await statusOf(id)).status).toBe("cancelled");
	});
});
