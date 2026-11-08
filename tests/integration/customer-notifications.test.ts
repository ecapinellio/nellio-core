import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/integration/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import { buildCustomerEmail } from "@/lib/notifications/email";

vi.mock("server-only", () => ({}));
const { sendPendingNotifications } = await import("@/lib/notifications/send");

const date = "2026-11-10";

describe("customer notifications and tracking (fulfillment phase 2)", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let withEmail: string;
	let noEmail: string;
	let productId: string;
	const anon = createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: c1 }, { data: c2 }, { data: p }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Mail Customer"),
			quickAddCustomer(tenant.admin, "No Mail Customer"),
			quickAddProduct(tenant.admin, "Mail Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		withEmail = c1!.id;
		noEmail = c2!.id;
		productId = p!.id;
		expect((await tenant.service.from("customers").update({ email: "cliente@example.com" }).eq("id", withEmail)).error).toBeNull();
		// Tests run without signature uploads; record_delivery's proof rules are covered in record-delivery.test.ts.
		expect((await tenant.service.from("tenant_order_settings")
			.update({ require_signature: false, require_receiver_name: false }).eq("tenant_id", tenant.tenantId)).error).toBeNull();
	});

	afterAll(async () =>
	{
		vi.unstubAllGlobals();
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	async function order(customerId = withEmail, quantity = 10)
	{
		const { data, error } = await createOrder(tenant.admin, { customer_id: customerId, notes: "n", items: [{ product_id: productId, quantity }] });
		expect(error).toBeNull();
		return data!.order.id;
	}

	const assign = (id: string, expected: string) =>
		tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "8–12", p_expected_status: expected,
		});

	async function pickedUp(customerId = withEmail)
	{
		const id = await order(customerId);
		expect((await assign(id, "pending")).error).toBeNull();
		expect((await tenant.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		return id;
	}

	const deliver = (id: string, a: Record<string, unknown>) =>
		tenant.driver.rpc("record_delivery", {
			p_delivery_id: crypto.randomUUID(), p_order_id: id, p_outcome: "delivered", p_lines: [],
			p_receiver_name: "Ana", p_signature_path: null, p_photo_path: null, p_failure_reason: null, p_failure_note: null,
			p_payment_method: null, p_amount_collected: null, ...a,
		} as never);

	async function kinds(orderId: string)
	{
		const { data, error } = await tenant.service.from("order_notifications").select("kind, recipient, status").eq("order_id", orderId).order("created_at");
		expect(error).toBeNull();
		return data!.map((n) => n.kind);
	}

	it("queues one email per customer-facing step, none for reassign/accept", async () =>
	{
		const id = await order();
		expect((await assign(id, "pending")).error).toBeNull();
		expect((await assign(id, "confirmed")).error).toBeNull(); // reassign: no email
		expect((await tenant.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		const { data: items } = await tenant.service.from("order_items").select("id").eq("order_id", id);
		expect((await deliver(id, { p_lines: [{ order_item_id: items![0].id, delivered_quantity: 10 }] })).error).toBeNull();
		expect(await kinds(id)).toEqual(["received", "confirmed", "on_the_way", "delivered"]);
	});

	it("failed, reprogram and cancel", async () =>
	{
		const id = await pickedUp();
		expect((await deliver(id, { p_outcome: "failed", p_failure_reason: "customer_closed" })).error).toBeNull();
		expect((await assign(id, "delivery_failed")).error).toBeNull();
		expect((await tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: "customer_refused", p_note: null as never, p_expected_status: "confirmed" })).error).toBeNull();
		expect(await kinds(id)).toEqual(["received", "confirmed", "on_the_way", "failed", "rescheduled", "cancelled"]);
	});

	it("partial delivery", async () =>
	{
		const id = await pickedUp();
		const { data: items } = await tenant.service.from("order_items").select("id").eq("order_id", id);
		expect((await deliver(id, { p_lines: [{ order_item_id: items![0].id, delivered_quantity: 4, reason: "short" }] })).error).toBeNull();
		expect((await kinds(id)).at(-1)).toBe("partially_delivered");
	});

	it("nothing for a customer without email or an action switched off", async () =>
	{
		expect(await kinds(await order(noEmail))).toEqual([]);
		await tenant.service.from("tenant_order_settings").update({ customer_email_actions: ["pick_up"] }).eq("tenant_id", tenant.tenantId);
		const id = await order();
		expect((await assign(id, "pending")).error).toBeNull();
		expect(await kinds(id)).toEqual([]);
		await tenant.service.from("tenant_order_settings")
			.update({ customer_email_actions: ["create", "assign", "pick_up", "deliver", "fail", "cancel"] }).eq("tenant_id", tenant.tenantId);
	});

	it("outbox is read-only for staff, invisible to drivers and other tenants; claim is service-only", async () =>
	{
		const id = await order();
		expect((await tenant.operator.from("order_notifications").select("id").eq("order_id", id)).data).toHaveLength(1);
		expect((await tenant.driver.from("order_notifications").select("id").eq("order_id", id)).data).toHaveLength(0);
		expect((await other.admin.from("order_notifications").select("id").eq("order_id", id)).data).toHaveLength(0);
		expect((await tenant.admin.from("order_notifications").update({ status: "sent" }).eq("order_id", id)).error?.code).toBe("42501");
		expect((await tenant.admin.rpc("claim_order_notifications", { p_limit: 1 })).error?.code).toBe("42501");
		// tracking_token is set by the default only.
		const { error } = await tenant.admin.from("orders").update({ tracking_token: "x".repeat(64) } as never).eq("id", id);
		expect(error?.code).toBe("42501");
	});

	it("tracking page data: public, no prices, hides reassign, expires 30 days after closing", async () =>
	{
		const id = await order();
		expect((await assign(id, "pending")).error).toBeNull();
		expect((await assign(id, "confirmed")).error).toBeNull();
		const { data: o } = await tenant.service.from("orders").select("tracking_token").eq("id", id).single();
		const token = o!.tracking_token;

		const { data, error } = await anon.rpc("get_order_tracking", { p_token: token });
		expect(error).toBeNull();
		const t = data as Record<string, unknown>;
		expect(t).toMatchObject({ order_ref: id.slice(0, 8), category: "preparing", delivery_date: date, delivery_window: "8–12" });
		expect((t.events as unknown[]).length).toBe(2); // created + confirmed, not the reassignment
		expect(JSON.stringify(t)).not.toMatch(/price|signature|photo|tenant_id|customer/);

		expect((await anon.rpc("get_order_tracking", { p_token: "0".repeat(64) })).data).toBeNull();
		expect((await anon.rpc("get_order_tracking", { p_token: "short" })).data).toBeNull();

		expect((await tenant.operator.rpc("cancel_order", { p_order_id: id, p_reason: "customer_refused", p_note: null as never, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await anon.rpc("get_order_tracking", { p_token: token })).data).not.toBeNull();
		await tenant.service.from("orders").update({ status_changed_at: new Date(Date.now() - 31 * 86_400_000).toISOString() }).eq("id", id);
		expect((await anon.rpc("get_order_tracking", { p_token: token })).data).toBeNull();
	});

	it("sender: marks sent on 2xx, retries on error, gives up after 5 attempts", async () =>
	{
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.stubEnv("EMAIL_FROM", "pedidos@example.com");
		const id = await order();
		const sent: { headers: Record<string, string>; body: { to: string[]; subject: string } }[] = [];
		const realFetch = globalThis.fetch;
		// Only Resend is faked; supabase-js uses fetch too.
		const fakeResend = (status: number) => vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
		{
			if (!String(url).startsWith("https://api.resend.com/"))
			{
				return realFetch(url, init);
			}
			sent.push({ headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
			return new Response(status === 200 ? "{}" : "boom", { status });
		});

		vi.stubGlobal("fetch", fakeResend(200));
		await sendPendingNotifications(tenant.service);
		const mine = sent.filter((s) => s.body.subject.includes(id.slice(0, 8)));
		expect(mine).toHaveLength(1);
		expect(mine[0].body.to).toEqual(["cliente@example.com"]);
		const { data: n } = await tenant.service.from("order_notifications").select("id, status, attempts").eq("order_id", id).single();
		expect(n).toMatchObject({ status: "sent", attempts: 1 });
		expect(mine[0].headers["Idempotency-Key"]).toBe(n!.id);

		const id2 = await order();
		vi.stubGlobal("fetch", fakeResend(500));
		await sendPendingNotifications(tenant.service);
		let { data: f } = await tenant.service.from("order_notifications").select("status, attempts, last_error").eq("order_id", id2).single();
		expect(f).toMatchObject({ status: "pending", attempts: 1 });
		expect(f!.last_error).toContain("Resend 500");

		// Not due again until next_attempt_at; force it to simulate the next runs.
		for (let i = 0; i < 4; i++)
		{
			await tenant.service.from("order_notifications").update({ next_attempt_at: new Date(0).toISOString() }).eq("order_id", id2);
			await sendPendingNotifications(tenant.service);
		}
		({ data: f } = await tenant.service.from("order_notifications").select("status, attempts, last_error").eq("order_id", id2).single());
		expect(f).toMatchObject({ status: "failed", attempts: 5 });
		vi.unstubAllEnvs();
	});
});

describe("buildCustomerEmail", () =>
{
	const base = {
		company: "ECTEC", customerName: "Ferretería <El Progreso>", orderRef: "abcd1234", trackingUrl: "https://x.test/t/tok",
		deliveryDate: "2026-11-10", deliveryWindow: "8–12", receiverName: "Ana", deliveredAt: "2026-11-10T20:05:00Z", missing: [],
	};

	it("confirmed says when it arrives", () =>
	{
		const e = buildCustomerEmail("confirmed", base);
		expect(e.subject).toBe("ECTEC: Tu pedido #abcd1234 está confirmado");
		expect(e.text).toContain("llega el martes 10 de noviembre, 8–12.");
		expect(e.text).toContain("https://x.test/t/tok");
	});

	it("partial lists what was missing, in the tenant's time zone, and escapes HTML", () =>
	{
		const e = buildCustomerEmail("partially_delivered", { ...base, missing: [{ product: "Cloro", quantity: 6 }] });
		expect(e.text).toContain("Lo recibió Ana el 10/11/2026 14:05.");
		expect(e.text).toContain("- 6 × Cloro");
		expect(e.html).toContain("Ferretería &lt;El Progreso&gt;");
		expect(e.html).not.toContain("<El Progreso>");
	});
});
