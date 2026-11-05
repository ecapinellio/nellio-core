import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);
const png = () => new Blob([PNG], { type: "image/png" });
const date = "2026-11-10";

describe("record_delivery", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let customerId: string;
	let productId: string;
	let product2Id: string;

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: c, error: ce }, { data: p, error: pe }, { data: p2, error: pe2 }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Delivery Customer"),
			quickAddProduct(tenant.admin, "Delivery Product", { pricePerUnit: 10, unit: "kg" }),
			quickAddProduct(tenant.admin, "Delivery Product 2", { pricePerUnit: 5, unit: "kg" }),
		]);
		expect(ce).toBeNull();
		expect(pe).toBeNull();
		expect(pe2).toBeNull();
		customerId = c!.id;
		productId = p!.id;
		product2Id = p2!.id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	/** Order assigned to the driver and picked up, through the real RPCs. */
	async function pickedUp(quantities = [10])
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId, notes: "n",
			items: quantities.map((q, i) => ({ product_id: i === 0 ? productId : product2Id, quantity: q })),
		});
		expect(error).toBeNull();
		const id = data!.order.id;
		const a = await tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "AM", p_expected_status: "pending",
		});
		expect(a.error).toBeNull();
		expect((await tenant.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		const { data: items, error: ie } = await tenant.service.from("order_items").select("id, quantity").eq("order_id", id).order("created_at");
		expect(ie).toBeNull();
		return { id, items: items! };
	}

	async function upload(deliveryId: string, file = "signature.png", client = tenant.driver, tenantId = tenant.tenantId)
	{
		const path = `${tenantId}/${deliveryId}/${file}`;
		const { error } = await client.storage.from("delivery-proofs").upload(path, png(), { contentType: "image/png" });
		expect(error).toBeNull();
		return path;
	}

	type Args = Partial<{
		p_delivery_id: string; p_order_id: string; p_outcome: string; p_lines: unknown; p_receiver_name: string | null;
		p_signature_path: string | null; p_photo_path: string | null; p_failure_reason: string | null; p_failure_note: string | null;
		p_payment_method: string | null; p_amount_collected: number | null;
	}>;
	const call = (c: TestTenant["driver"], orderId: string, a: Args) =>
		c.rpc("record_delivery", {
			p_delivery_id: crypto.randomUUID(), p_order_id: orderId, p_outcome: "delivered", p_lines: [],
			p_receiver_name: null, p_signature_path: null, p_photo_path: null, p_failure_reason: null, p_failure_note: null,
			p_payment_method: null, p_amount_collected: null, ...a,
		} as never);
	const full = (items: { id: string; quantity: number }[]) =>
		items.map((i) => ({ order_item_id: i.id, delivered_quantity: i.quantity }));

	async function row<T extends "orders" | "order_events" | "order_deliveries">(t: T, id: string, col = "id")
	{
		const { data, error } = await tenant.service.from(t).select("*").eq(col, id);
		expect(error).toBeNull();
		return data as any[];
	}

	async function setSettings(patch: Record<string, boolean>)
	{
		const { error } = await tenant.service.from("tenant_order_settings").update(patch).eq("tenant_id", tenant.tenantId);
		expect(error).toBeNull();
	}

	it("full delivery with signature and name -> delivered, invoice pending, proof readable by operator", async () =>
	{
		const { id, items } = await pickedUp([10, 4]);
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const r = await call(tenant.driver, id, {
			p_delivery_id: did, p_lines: full(items), p_receiver_name: "  Juan Pérez ", p_signature_path: sig,
			p_payment_method: "cash", p_amount_collected: 90,
		});
		expect(r.error).toBeNull();
		expect(r.data).toMatchObject({
			order: { id, status: "delivered", invoice_status: "pending" },
			delivery: { id: did, outcome: "delivered", receiver_name: "Juan Pérez", signature_path: sig, payment_method: "cash" },
		});
		const [o] = await row("orders", id);
		expect(o.status).toBe("delivered");
		const lines = await row("order_items", id, "order_id");
		expect(lines.map((l) => Number(l.delivered_quantity)).sort((a, b) => a - b)).toEqual([4, 10]);
		const ev = (await row("order_events", id, "order_id")).filter((e) => e.action === "deliver");
		expect(ev).toHaveLength(1);
		expect(ev[0].payload).toMatchObject({ delivery_id: did, partial: false });

		const dl = await tenant.operator.storage.from("delivery-proofs").download(sig);
		expect(dl.error).toBeNull();
		expect(dl.data!.size).toBe(PNG.length);
		expect((await tenant.operator.from("order_deliveries").select("id").eq("id", did)).data).toHaveLength(1);
		// No direct writes, no reads for drivers.
		expect((await tenant.driver.from("order_deliveries").select("id")).data).toEqual([]);
		expect((await tenant.driver.from("order_deliveries").insert({ id: crypto.randomUUID(), tenant_id: tenant.tenantId, order_id: id, outcome: "failed" } as never)).error).not.toBeNull();
	});

	it("missing signature or receiver name is rejected; photo required only when the setting is on", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const base = { p_delivery_id: did, p_lines: full(items) };
		expect((await call(tenant.driver, id, { ...base, p_receiver_name: "Ana" })).error?.code).toBe("22004");
		expect((await call(tenant.driver, id, { ...base, p_receiver_name: "  ", p_signature_path: sig })).error?.code).toBe("22004");
		await setSettings({ require_photo: true });
		try
		{
			expect((await call(tenant.driver, id, { ...base, p_receiver_name: "Ana", p_signature_path: sig })).error?.code).toBe("22004");
			const photo = await upload(did, "photo.jpg");
			expect((await call(tenant.driver, id, { ...base, p_receiver_name: "Ana", p_signature_path: sig, p_photo_path: photo })).error).toBeNull();
		}
		finally
		{
			await setSettings({ require_photo: false });
		}
		// With the requirements off, nothing is needed.
		await setSettings({ require_signature: false, require_receiver_name: false });
		try
		{
			const p2 = await pickedUp();
			expect((await call(tenant.driver, p2.id, { p_lines: full(p2.items) })).error).toBeNull();
		}
		finally
		{
			await setSettings({ require_signature: true, require_receiver_name: true });
		}
	});

	it("partial delivery stores delivered quantities and reasons -> partially_delivered", async () =>
	{
		const { id, items } = await pickedUp([10, 4]);
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const r = await call(tenant.driver, id, {
			p_delivery_id: did, p_receiver_name: "Ana", p_signature_path: sig, p_payment_method: "credit",
			p_lines: [
				{ order_item_id: items[0].id, delivered_quantity: 6.5, reason: "damaged", note: "caja rota" },
				{ order_item_id: items[1].id, delivered_quantity: 4 },
			],
		});
		expect(r.error).toBeNull();
		expect(r.data).toMatchObject({ order: { status: "partially_delivered", invoice_status: "pending" }, delivery: { outcome: "partially_delivered" } });
		const lines = await row("order_items", id, "order_id");
		const short = lines.find((l) => l.id === items[0].id);
		expect(Number(short.delivered_quantity)).toBe(6.5);
		expect(short).toMatchObject({ shortfall_reason: "damaged", shortfall_note: "caja rota" });
		expect(lines.find((l) => l.id === items[1].id)).toMatchObject({ shortfall_reason: null });
		const ev = (await row("order_events", id, "order_id")).find((e) => e.action === "deliver");
		expect(ev.payload).toMatchObject({ delivery_id: did, partial: true });
	});

	it("all lines at zero is rejected", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const r = await call(tenant.driver, id, {
			p_delivery_id: did, p_receiver_name: "Ana", p_signature_path: sig,
			p_lines: items.map((i) => ({ order_item_id: i.id, delivered_quantity: 0, reason: "refused" })),
		});
		expect(r.error?.code).toBe("22023");
		expect((await row("orders", id))[0].status).toBe("dispatched");
	});

	it("rejects bad delivered quantities", async () =>
	{
		const { id, items } = await pickedUp([10, 4]);
		const foreign = (await pickedUp([3])).items[0];
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const base = { p_delivery_id: did, p_receiver_name: "Ana", p_signature_path: sig };
		const [a, b] = items;
		const bad = async (lines: unknown, label: string) =>
			expect((await call(tenant.driver, id, { ...base, p_lines: lines })).error?.code, label).toBe("22023");
		await bad([{ order_item_id: a.id, delivered_quantity: -1, reason: "short" }, { order_item_id: b.id, delivered_quantity: 4 }], "negative");
		await bad([{ order_item_id: a.id, delivered_quantity: "NaN", reason: "short" }, { order_item_id: b.id, delivered_quantity: 4 }], "NaN string");
		await bad([{ order_item_id: a.id, delivered_quantity: 11 }, { order_item_id: b.id, delivered_quantity: 4 }], "above ordered");
		await bad([{ order_item_id: a.id, delivered_quantity: 10 }, { order_item_id: foreign.id, delivered_quantity: 3 }], "foreign item");
		await bad([{ order_item_id: a.id, delivered_quantity: 10 }], "missing line");
		await bad([{ order_item_id: a.id, delivered_quantity: 10 }, { order_item_id: a.id, delivered_quantity: 10 }], "duplicate line");
		await bad([{ order_item_id: a.id, delivered_quantity: 5 }, { order_item_id: b.id, delivered_quantity: 4 }], "shortfall without reason");
		await bad([{ order_item_id: a.id, delivered_quantity: 5, reason: "nope" }, { order_item_id: b.id, delivered_quantity: 4 }], "bad reason");
		await bad({ order_item_id: a.id }, "not an array");
		await bad([{ order_item_id: "x", delivered_quantity: 1 }, { order_item_id: b.id, delivered_quantity: 4 }], "bad id");
		expect((await row("order_deliveries", id, "order_id"))).toHaveLength(0);
		expect((await row("orders", id))[0].status).toBe("dispatched");
	});

	it("rejects proof paths outside tenant/delivery", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const mine = await upload(did);
		const otherDelivery = await upload(crypto.randomUUID());
		const base = { p_delivery_id: did, p_receiver_name: "Ana", p_lines: full(items) };
		const code = async (sig: string, label: string) =>
			expect((await call(tenant.driver, id, { ...base, p_signature_path: sig })).error?.code, label).toBe("22023");
		await code(otherDelivery, "other delivery");
		await code(`${other.tenantId}/${did}/signature.png`, "other tenant");
		await code(`${tenant.tenantId}/${did}/missing.png`, "no object");
		await code(`${tenant.tenantId}/${did}/../x/signature.png`, "dotdot");
		await code(`${tenant.tenantId}/${did}`, "no file part");
		await code(mine.replace(`${did}/`, `${did}x/`), "prefix lookalike");
		expect((await call(tenant.driver, id, { ...base, p_signature_path: mine })).error).toBeNull();
	});

	it("failed delivery needs a reason -> delivery_failed; office can reprogram it", async () =>
	{
		const { id } = await pickedUp();
		const failed = (a: Args) => call(tenant.driver, id, { p_outcome: "failed", ...a });
		expect((await failed({})).error?.code).toBe("22004");
		expect((await failed({ p_failure_reason: "nope" })).error?.code).toBe("22023");
		expect((await failed({ p_failure_reason: "other", p_failure_note: " " })).error?.code).toBe("22004");
		expect((await failed({ p_failure_reason: "customer_closed", p_payment_method: "cash", p_amount_collected: 1 })).error?.code).toBe("22023");
		const did = crypto.randomUUID();
		const r = await failed({ p_delivery_id: did, p_failure_reason: "other", p_failure_note: "nadie abrió" });
		expect(r.error).toBeNull();
		expect(r.data).toMatchObject({
			order: { status: "delivery_failed", invoice_status: "not_invoiced" },
			delivery: { outcome: "failed", failure_reason: "other", failure_note: "nadie abrió" },
		});
		const ev = (await row("order_events", id, "order_id")).filter((e) => e.action === "fail");
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ reason: "other", note: "nadie abrió" });

		const a = await tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "PM", p_expected_status: "delivery_failed",
		});
		expect(a.error).toBeNull();
		expect(a.data).toMatchObject({ status: "confirmed" });
		expect((await tenant.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		const list = (await tenant.driver.rpc("list_driver_orders")).data as any[];
		expect(list.find((o) => o.id === id).attempt).toBe(2);
	});

	it("retry with the same delivery id is a no-op", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const args = { p_delivery_id: did, p_lines: full(items), p_receiver_name: "Ana", p_signature_path: sig };
		const first = await call(tenant.driver, id, args);
		expect(first.error).toBeNull();
		// The order already left picked_up because of this very delivery.
		const second = await call(tenant.driver, id, args);
		expect(second.error).toBeNull();
		expect(second.data).toEqual(first.data);
		expect((await row("order_events", id, "order_id")).filter((e) => e.action === "deliver")).toHaveLength(1);
		expect(await row("order_deliveries", id, "order_id")).toHaveLength(1);

		// Same delivery id for a different order, or by a different driver: rejected, nothing overwritten.
		const o2 = await pickedUp();
		expect((await call(tenant.driver, o2.id, { ...args, p_lines: full(o2.items) })).error?.code).toBe("22023");
		expect((await row("orders", o2.id))[0].status).toBe("dispatched");
		expect((await call(other.driver, id, args)).error?.code).toBe("P0002");
		const { data: [d] } = await tenant.service.from("order_deliveries").select("order_id, receiver_name").eq("id", did) as any;
		expect(d).toMatchObject({ order_id: id, receiver_name: "Ana" });
	});

	it("a delivery id used by another driver of the same tenant is rejected", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		expect((await call(tenant.driver, id, { p_delivery_id: did, p_lines: full(items), p_receiver_name: "Ana", p_signature_path: sig })).error).toBeNull();
		// Simulate a stored row belonging to someone else.
		const { error } = await tenant.service.from("order_deliveries").update({ driver_id: tenant.operatorId }).eq("id", did);
		expect(error).toBeNull();
		const r = await call(tenant.driver, id, { p_delivery_id: did, p_lines: full(items), p_receiver_name: "Ana", p_signature_path: sig });
		expect(r.error?.code).toBe("22023");
	});

	it("driver cannot upload under another tenant's folder; operator of another tenant cannot read", async () =>
	{
		const did = crypto.randomUUID();
		const bad = await tenant.driver.storage.from("delivery-proofs")
			.upload(`${other.tenantId}/${did}/signature.png`, png(), { contentType: "image/png" });
		expect(bad.error).not.toBeNull();
		expect((await tenant.operator.storage.from("delivery-proofs").upload(`${tenant.tenantId}/${did}/signature.png`, png())).error).not.toBeNull();

		const path = await upload(did);
		expect((await other.operator.storage.from("delivery-proofs").download(path)).error).not.toBeNull();
		expect((await other.admin.storage.from("delivery-proofs").download(path)).error).not.toBeNull();
		expect((await tenant.admin.storage.from("delivery-proofs").download(path)).error).toBeNull();
		// No overwrite and no delete.
		expect((await tenant.driver.storage.from("delivery-proofs").upload(path, png(), { upsert: true })).error).not.toBeNull();
		const rm = await tenant.driver.storage.from("delivery-proofs").remove([path]);
		expect(rm.data ?? []).toHaveLength(0);
		expect((await tenant.admin.storage.from("delivery-proofs").download(path)).error).toBeNull();
	});

	it("only the assigned driver, only from picked_up", async () =>
	{
		const { id, items } = await pickedUp();
		const args = { p_lines: full(items), p_receiver_name: "Ana" };
		expect((await call(tenant.operator, id, args)).error?.code).toBe("42501");
		expect((await call(tenant.admin, id, args)).error?.code).toBe("42501");
		expect((await call(other.driver, id, args)).error?.code).toBe("P0002");
		expect((await call(tenant.driver, crypto.randomUUID(), args)).error?.code).toBe("P0002");
	});

	it("not from confirmed or accepted", async () =>
	{
		const { data } = await createOrder(tenant.admin, { customer_id: customerId, notes: "n", items: [{ product_id: productId, quantity: 1 }] });
		const id = data!.order.id;
		await tenant.operator.rpc("assign_order", { p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "AM", p_expected_status: "pending" });
		const { data: items } = await tenant.service.from("order_items").select("id, quantity").eq("order_id", id);
		const r = await call(tenant.driver, id, { p_lines: full(items!), p_receiver_name: "Ana" });
		expect(r.error?.code).toBe("22023");
	});

	it("payment: amount only with a non-credit method", async () =>
	{
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		const base = { p_delivery_id: did, p_lines: full(items), p_receiver_name: "Ana", p_signature_path: sig };
		expect((await call(tenant.driver, id, { ...base, p_payment_method: "bitcoin" })).error?.code).toBe("22023");
		expect((await call(tenant.driver, id, { ...base, p_payment_method: "credit", p_amount_collected: 5 })).error?.code).toBe("22023");
		expect((await call(tenant.driver, id, { ...base, p_amount_collected: 5 })).error?.code).toBe("22023");
		expect((await call(tenant.driver, id, { ...base, p_payment_method: "cash", p_amount_collected: -1 })).error?.code).toBe("22023");
		expect((await call(tenant.driver, id, { ...base, p_payment_method: "check", p_amount_collected: 100 })).error).toBeNull();
	});

	it("admin correction into delivered: without_signature only when no delivery was recorded; issued/error invoices untouched", async () =>
	{
		const correct = (id: string, status: string, expected: string) =>
			tenant.admin.rpc("correct_order_status", { p_order_id: id, p_status: status, p_reason: "x", p_expected_status: expected });
		const evs = async (id: string) => (await row("order_events", id, "order_id")).filter((e) => e.action === "correct");

		// Really delivered, then moved out and back: has proof, so not without_signature.
		const { id, items } = await pickedUp();
		const did = crypto.randomUUID();
		const sig = await upload(did);
		expect((await call(tenant.driver, id, { p_delivery_id: did, p_lines: full(items), p_receiver_name: "Ana", p_signature_path: sig })).error).toBeNull();
		expect((await correct(id, "confirmed", "delivered")).error).toBeNull();
		expect((await correct(id, "delivered", "confirmed")).error).toBeNull();
		const back = (await evs(id)).find((e) => e.to_status === "delivered");
		expect(back.payload.without_signature).toBeUndefined();

		// Failed delivery only: still without_signature.
		const f = await pickedUp();
		expect((await call(tenant.driver, f.id, { p_outcome: "failed", p_failure_reason: "customer_closed" })).error).toBeNull();
		expect((await correct(f.id, "delivered", "delivery_failed")).error).toBeNull();
		expect((await evs(f.id))[0].payload).toMatchObject({ without_signature: true });

		// invoice_status: only not_invoiced becomes pending.
		for (const inv of ["issued", "error"])
		{
			const o = await pickedUp();
			expect((await tenant.service.from("orders").update({ invoice_status: inv }).eq("id", o.id)).error).toBeNull();
			expect((await correct(o.id, "delivered", "dispatched")).error).toBeNull();
			expect((await row("orders", o.id))[0].invoice_status).toBe(inv);
		}
	});
});
