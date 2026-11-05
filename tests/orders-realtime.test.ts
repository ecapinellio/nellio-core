import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import { assignOrder } from "@/lib/orders/actions-client";
import { subscribeToOrders } from "@/lib/supabase/orders-live";

// How long "no event arrived" is waited for. Realtime usually delivers in ms.
const QUIET_MS = 1500;

const service = createClient<Database>(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
	{ auth: { persistSession: false, autoRefreshToken: false } },
);

describe("live /orders (ADR-010)", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	let orderId: string;
	const channels: [SupabaseClient<Database>, RealtimeChannel][] = [];

	/** Subscribes for real and returns a live count of the events received. */
	async function listen(client: SupabaseClient<Database>, tenantId: string)
	{
		const received = { count: 0 };
		await new Promise<void>((resolve, reject) =>
		{
			subscribeToOrders(client, tenantId, () => received.count++, (status) =>
			{
				if (status === "SUBSCRIBED")
				{
					resolve();
				}
				else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
				{
					reject(new Error(`Realtime channel ${status}`));
				}
			})
				.then((channel) => channels.push([client, channel]))
				.catch(reject);
		});
		// SUBSCRIBED is the channel; the database listener lands just after it.
		await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
		return received;
	}

	async function settle(received: { count: number }, expectEvent: boolean)
	{
		await expect.poll(() => received.count > 0, { timeout: expectEvent ? 5000 : QUIET_MS }).toBe(expectEvent);
		if (!expectEvent)
		{
			await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
			expect(received.count).toBe(0);
		}
	}

	async function stop()
	{
		await Promise.all(channels.splice(0).map(([client, channel]) => client.removeChannel(channel)));
	}

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Realtime Customer"),
			quickAddProduct(tenant.admin, "Realtime Product", { pricePerUnit: 8, unit: "each" }),
		]);
		const { data } = await createOrder(tenant.admin, {
			customer_id: customer!.id,
			notes: "realtime fixture",
			items: [{ product_id: product!.id, quantity: 1 }],
		});
		orderId = data!.order.id;

		// Realtime starts replicating with its first subscriber and events before
		// that are lost: poke until one arrives so no test depends on the cold start.
		const warm = await listen(tenant.operator, tenant.tenantId);
		for (let attempt = 0; attempt < 60 && warm.count === 0; attempt++)
		{
			await tenant.admin.from("orders").update({ notes: "realtime warm-up" }).eq("id", orderId);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		await stop();
	}, 40_000);

	afterAll(async () =>
	{
		await stop();
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	/** Puts the order back to pending (service_role: API roles can't write status). Do it before listening. */
	async function reset()
	{
		const { error } = await service.from("orders")
			.update({ status: "pending", driver_id: null, delivery_date: null, delivery_window: null })
			.eq("id", orderId);
		expect(error).toBeNull();
	}

	/** Moves the order through the office RPC: direct status writes are closed to API roles. */
	function assign(window: string, expectedStatus: string)
	{
		return assignOrder(tenant.admin, orderId, {
			driverId: tenant.driverId, deliveryDate: "2026-11-10", deliveryWindow: window, expectedStatus,
		});
	}

	it("tells another session of the same tenant when an order moves", async () =>
	{
		await reset();
		const received = await listen(tenant.operator, tenant.tenantId);
		expect((await assign("AM", "pending")).error).toBeNull();
		await settle(received, true);
		await stop();
	});

	// The browser client restores its session from cookies, so nothing signs in
	// and Realtime would connect as anon, seeing nothing through RLS.
	it("works for a client that restored its session instead of signing in", async () =>
	{
		const { data: { session } } = await tenant.operator.auth.getSession();
		const saved = new Map([["restored", JSON.stringify(session)]]);
		const restored = createClient<Database>(
			process.env.NEXT_PUBLIC_SUPABASE_URL!,
			process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
			{
				auth: {
					storageKey: "restored",
					autoRefreshToken: false,
					storage: {
						getItem: (key) => saved.get(key) ?? null,
						setItem: (key, value) => void saved.set(key, value),
						removeItem: (key) => void saved.delete(key),
					},
				},
			},
		);

		const received = await listen(restored, tenant.tenantId);
		await tenant.admin.from("orders").update({ notes: "restored session" }).eq("id", orderId);
		await settle(received, true);
		await stop();
	});

	it("tells another session when a line of an order changes", async () =>
	{
		const received = await listen(tenant.operator, tenant.tenantId);
		expect((await tenant.admin.from("order_items").update({ quantity: 2 }).eq("order_id", orderId)).error).toBeNull();
		await settle(received, true);
		await stop();
	});

	it("tells nothing to another tenant, even with a forged filter", async () =>
	{
		await reset();
		const control = await listen(tenant.operator, tenant.tenantId);
		const own = await listen(otherTenant.operator, otherTenant.tenantId);
		const forged = await listen(otherTenant.admin, tenant.tenantId);
		expect((await assign("PM", "pending")).error).toBeNull();
		await settle(control, true);
		await settle(own, false);
		await settle(forged, false);
		await stop();
	});

	// Realtime applies neither RLS nor filters to DELETE events, so the board
	// must not listen to them: here, another tenant being offboarded.
	it("tells nothing when another tenant's orders are deleted", async () =>
	{
		const leaving = await setupTenant();
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(leaving.admin, "Leaving Customer"),
			quickAddProduct(leaving.admin, "Leaving Product", { pricePerUnit: 1, unit: "each" }),
		]);
		expect((await createOrder(leaving.admin, {
			customer_id: customer!.id,
			notes: "leaving",
			items: [{ product_id: product!.id, quantity: 1 }],
		})).error).toBeNull();

		const received = await listen(tenant.operator, tenant.tenantId);
		await leaving.teardown();
		await settle(received, false);

		// Still listening: a change of its own tenant arrives.
		expect((await tenant.admin.from("orders").update({ notes: "after delete" }).eq("id", orderId)).error).toBeNull();
		await settle(received, true);
		await stop();
	}, 30_000);

	// Drivers have a row-level policy of their own: only their orders reach them.
	it("a driver gets events only for their own orders", async () =>
	{
		const email = `rt-d2-${crypto.randomUUID()}@test.local`;
		const { data: u, error } = await service.auth.admin.createUser({
			email, password: "Nellio-Test-Pass-2026!", email_confirm: true,
			app_metadata: { tenant_id: tenant.tenantId, role: "driver" },
		});
		expect(error).toBeNull();
		const driver2Id = u.user!.id;
		try
		{
			expect((await service.from("users").insert({ id: driver2Id, tenant_id: tenant.tenantId, name: "RT D2", role: "driver" })).error).toBeNull();
			const driver2 = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
				auth: { autoRefreshToken: false, persistSession: false },
			});
			expect((await driver2.auth.signInWithPassword({ email, password: "Nellio-Test-Pass-2026!" })).error).toBeNull();

			await reset();
			const mine = await listen(tenant.driver, tenant.tenantId);
			const other = await listen(driver2, tenant.tenantId);
			const { error: assignError } = await tenant.operator.rpc("assign_order", {
				p_order_id: orderId, p_driver_id: tenant.driverId, p_delivery_date: "2026-11-10",
				p_delivery_window: "AM", p_expected_status: "pending",
			});
			expect(assignError).toBeNull();
			await settle(mine, true);
			await settle(other, false);
			await stop();
		}
		finally
		{
			await stop();
			await service.auth.admin.deleteUser(driver2Id);
		}
	}, 30_000);

	it("stops telling a deactivated user (ADR-009)", async () =>
	{
		const control = await listen(tenant.operator, tenant.tenantId);
		const received = await listen(tenant.driver, tenant.tenantId);
		expect((await service.auth.admin.updateUserById(tenant.driverId, { ban_duration: "1h" })).error).toBeNull();
		try
		{
			// The banned driver can't be assigned any more: change the order another way.
			expect((await tenant.admin.from("orders").update({ notes: "after ban" }).eq("id", orderId)).error).toBeNull();
			await settle(control, true);
			await settle(received, false);
		}
		finally
		{
			await stop();
		}
	});
});
