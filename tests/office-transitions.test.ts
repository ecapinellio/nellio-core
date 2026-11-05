import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

describe("office transitions", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let customerId: string;
	let productId: string;
	const date = "2026-11-10";

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Office Customer"),
			quickAddProduct(tenant.admin, "Office Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	async function fresh(status = "pending", extra: Record<string, unknown> = {})
	{
		const { data } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "n",
			items: [{ product_id: productId, quantity: 2 }],
		});
		const id = data!.order.id;
		if (status !== "pending" || Object.keys(extra).length)
		{
			const { error } = await tenant.service.from("orders").update({ status, ...extra }).eq("id", id);
			expect(error).toBeNull();
		}
		return id;
	}

	const assign = (c: TestTenant["operator"], id: string, driver: string, expected: string, window: string | null = "AM") =>
		c.rpc("assign_order", {
			p_order_id: id, p_driver_id: driver, p_delivery_date: date, p_delivery_window: window as string, p_expected_status: expected,
		});

	async function events(id: string, action: string)
	{
		const { data } = await tenant.service.from("order_events").select("*").eq("order_id", id).eq("action", action);
		return data!;
	}

	it("confirm assigns driver and window, logs assign", async () =>
	{
		const id = await fresh();
		const { data, error } = await assign(tenant.operator, id, tenant.driverId, "pending");
		expect(error).toBeNull();
		expect(data).toMatchObject({ status: "confirmed", driver_id: tenant.driverId, delivery_date: date, delivery_window: "AM" });
		const ev = await events(id, "assign");
		expect(ev).toHaveLength(1);
		expect(ev[0].payload).toMatchObject({ driver_id: tenant.driverId, delivery_date: date, delivery_window: "AM", previous_driver_id: null });
		expect(ev[0].from_status).toBe("pending");
		expect(ev[0].to_status).toBe("confirmed");
	});

	it("reassign and reprogram go back to confirmed", async () =>
	{
		const { data: u } = await tenant.service.auth.admin.createUser({
			email: `d2-${crypto.randomUUID()}@test.local`, password: "Nellio-Test-Pass-2026!", email_confirm: true,
			app_metadata: { tenant_id: tenant.tenantId, role: "driver" },
		});
		await tenant.service.from("users").insert({ id: u.user!.id, tenant_id: tenant.tenantId, name: "D2", role: "driver" });
		const a = await fresh("accepted", { driver_id: tenant.driverId });
		const r1 = await assign(tenant.operator, a, u.user!.id, "accepted");
		expect(r1.error).toBeNull();
		expect(r1.data).toMatchObject({ status: "confirmed", driver_id: u.user!.id });
		expect((await events(a, "assign"))[0].payload).toMatchObject({ previous_driver_id: tenant.driverId });

		const f = await fresh("delivery_failed", { driver_id: tenant.driverId });
		const r2 = await assign(tenant.admin, f, u.user!.id, "delivery_failed", null);
		expect(r2.error).toBeNull();
		expect(r2.data).toMatchObject({ status: "confirmed", driver_id: u.user!.id });
		await tenant.service.auth.admin.deleteUser(u.user!.id);
	});

	it("assign rejects inactive, foreign or non-driver users", async () =>
	{
		const { data: u } = await tenant.service.auth.admin.createUser({
			email: `d3-${crypto.randomUUID()}@test.local`, password: "Nellio-Test-Pass-2026!", email_confirm: true,
			app_metadata: { tenant_id: tenant.tenantId, role: "driver" },
		});
		await tenant.service.from("users").insert({ id: u.user!.id, tenant_id: tenant.tenantId, name: "D3", role: "driver" });
		await tenant.service.auth.admin.updateUserById(u.user!.id, { ban_duration: "24h" });
		const id = await fresh();
		for (const driver of [u.user!.id, other.driverId, tenant.operatorId, crypto.randomUUID()])
		{
			const { error } = await assign(tenant.operator, id, driver, "pending");
			expect(error?.code, driver).toBe("22023");
		}
		const { error: noDate } = await tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: null as unknown as string, p_delivery_window: "", p_expected_status: "pending",
		});
		expect(noDate?.code).toBe("22004");
		const { error: longWin } = await assign(tenant.operator, id, tenant.driverId, "pending", "x".repeat(101));
		expect(longWin?.code).toBe("22023");
		await tenant.service.auth.admin.deleteUser(u.user!.id);
	});

	it("assign from dispatched or delivered is rejected", async () =>
	{
		for (const s of ["dispatched", "delivered", "cancelled"])
		{
			const id = await fresh(s);
			const { error } = await assign(tenant.operator, id, tenant.driverId, s);
			expect(error?.code, s).toBe("22023");
		}
	});

	it("stale expected status is PT409; unknown or foreign order is P0002", async () =>
	{
		const id = await fresh();
		expect((await assign(tenant.operator, id, tenant.driverId, "confirmed")).error?.code).toBe("PT409");
		expect((await tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: "customer_closed", p_note: "", p_expected_status: "confirmed" })).error?.code).toBe("PT409");
		expect((await tenant.admin.rpc("correct_order_status", { p_order_id: id, p_status: "confirmed", p_reason: "x", p_expected_status: "confirmed" })).error?.code).toBe("PT409");
		expect((await assign(other.operator, id, other.driverId, "pending")).error?.code).toBe("P0002");
		expect((await assign(tenant.operator, crypto.randomUUID(), tenant.driverId, "pending")).error?.code).toBe("P0002");
	});

	it("driver cannot call office actions", async () =>
	{
		const id = await fresh();
		expect((await assign(tenant.driver, id, tenant.driverId, "pending")).error?.code).toBe("42501");
		expect((await tenant.driver.rpc("cancel_order", { p_order_id: id, p_reason: "customer_closed", p_note: "", p_expected_status: "pending" })).error?.code).toBe("42501");
		expect((await tenant.driver.rpc("correct_order_status", { p_order_id: id, p_status: "confirmed", p_reason: "x", p_expected_status: "pending" })).error?.code).toBe("42501");
		expect((await tenant.driver.rpc("list_tenant_drivers")).error?.code).toBe("42501");
	});

	it("cancel needs a reason, and other needs a note; not allowed in transit or delivered", async () =>
	{
		const cancel = (id: string, reason: string, note: string, expected: string) =>
			tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: reason, p_note: note, p_expected_status: expected });
		const id = await fresh("confirmed", { driver_id: tenant.driverId });
		expect((await cancel(id, "bogus", "", "confirmed")).error?.code).toBe("22023");
		expect((await cancel(id, "other", "  ", "confirmed")).error?.code).toBe("22004");
		const { data, error } = await cancel(id, "other", "se arrepintió", "confirmed");
		expect(error).toBeNull();
		expect(data).toMatchObject({ status: "cancelled", driver_id: tenant.driverId });
		const ev = await events(id, "cancel");
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ reason: "other", note: "se arrepintió", from_status: "confirmed" });
		for (const s of ["pending", "accepted", "delivery_failed"])
		{
			const o = await fresh(s);
			expect((await cancel(o, "wrong_address", "", s)).error, s).toBeNull();
		}
		for (const s of ["dispatched", "delivered", "partially_delivered", "cancelled"])
		{
			const o = await fresh(s);
			expect((await cancel(o, "wrong_address", "", s)).error?.code, s).toBe("22023");
		}
	});

	it("admin correction: any state with reason, operator denied, delivered without proof marks without_signature and pending invoice, issued invoice blocks leaving delivered", async () =>
	{
		const correct = (c: TestTenant["admin"], id: string, status: string, reason: string, expected: string) =>
			c.rpc("correct_order_status", { p_order_id: id, p_status: status, p_reason: reason, p_expected_status: expected });
		const id = await fresh("dispatched");
		expect((await correct(tenant.operator, id, "confirmed", "x", "dispatched")).error?.code).toBe("42501");
		expect((await correct(tenant.admin, id, "confirmed", "  ", "dispatched")).error?.code).toBe("22004");
		expect((await correct(tenant.admin, id, "nope", "x", "dispatched")).error?.code).toBe("22023");
		expect((await correct(tenant.admin, id, "dispatched", "x", "dispatched")).error?.code).toBe("22023");

		const back = await correct(tenant.admin, id, "confirmed", "se fue mal", "dispatched");
		expect(back.error).toBeNull();
		expect(back.data).toMatchObject({ status: "confirmed", invoice_status: "not_invoiced" });
		expect((await events(id, "correct"))[0]).toMatchObject({ reason: "se fue mal", from_status: "dispatched" });

		const d = await correct(tenant.admin, id, "delivered", "entregado por teléfono", "confirmed");
		expect(d.error).toBeNull();
		expect(d.data).toMatchObject({ status: "delivered", invoice_status: "pending" });
		const evs = await events(id, "correct");
		expect(evs.find(e => e.to_status === "delivered")!.payload).toMatchObject({ without_signature: true });

		const out = await correct(tenant.admin, id, "confirmed", "error", "delivered");
		expect(out.error).toBeNull();
		expect(out.data!.invoice_status).toBe("not_invoiced");

		const issued = await fresh("delivered", { invoice_status: "issued" });
		expect((await correct(tenant.admin, issued, "confirmed", "x", "delivered")).error?.code).toBe("22023");
	});

	it("step-less custom status cannot be assigned or cancelled", async () =>
	{
		const { error: e } = await tenant.service.from("order_statuses")
			.insert({ tenant_id: tenant.tenantId, key: "custom_x", label: "Custom", category: "preparing", step: null, position: 900 });
		expect(e).toBeNull();
		const id = await fresh("custom_x");
		expect((await assign(tenant.operator, id, tenant.driverId, "custom_x")).error?.code).toBe("22023");
		expect((await tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: "customer_closed", p_note: "", p_expected_status: "custom_x" })).error?.code).toBe("22023");
	});

	it("list_tenant_drivers returns only this tenant's drivers with active flag", async () =>
	{
		const { data, error } = await tenant.operator.rpc("list_tenant_drivers");
		expect(error).toBeNull();
		expect(data).toEqual([{ id: tenant.driverId, name: expect.any(String), active: true }]);
		await tenant.service.auth.admin.updateUserById(tenant.driverId, { ban_duration: "24h" });
		const { data: after } = await tenant.admin.rpc("list_tenant_drivers");
		expect(after![0].active).toBe(false);
		await tenant.service.auth.admin.updateUserById(tenant.driverId, { ban_duration: "none" });
	});
});
