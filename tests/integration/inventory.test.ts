import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/integration/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";

const date = "2026-11-10";

describe("inventory", () =>
{
	let tenant: TestTenant;
	let other: TestTenant;
	let customerId: string;

	beforeAll(async () =>
	{
		[tenant, other] = await Promise.all([setupTenant(), setupTenant()]);
		const { data: c } = await quickAddCustomer(tenant.admin, "Inventory Customer");
		customerId = c!.id;
		const { error } = await tenant.service.from("tenant_order_settings")
			.update({ require_signature: false, require_receiver_name: false }).eq("tenant_id", tenant.tenantId);
		expect(error).toBeNull();
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), other.teardown()]);
	});

	async function product(stock = 0)
	{
		const { data, error } = await quickAddProduct(tenant.admin, `Inv ${crypto.randomUUID()}`, { pricePerUnit: 1, unit: "kg" });
		expect(error).toBeNull();
		if (stock)
		{
			expect((await save([{ product_id: data!.id, kind: "count", quantity: stock }])).error).toBeNull();
		}
		return data!.id;
	}

	const save = (rows: unknown, client = tenant.admin) => client.rpc("save_stock_movements", { p_rows: rows as never });

	async function stock(productId: string)
	{
		const { data, error } = await tenant.operator.from("product_stock").select("stock").eq("id", productId).single();
		expect(error).toBeNull();
		return Number(data!.stock);
	}

	async function pickedUp(items: { product_id: string; quantity: number }[])
	{
		const { data, error } = await createOrder(tenant.admin, { customer_id: customerId, notes: "n", items });
		expect(error).toBeNull();
		const id = data!.order.id;
		expect((await tenant.operator.rpc("assign_order", {
			p_order_id: id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "AM", p_expected_status: "pending",
		})).error).toBeNull();
		expect((await tenant.driver.rpc("respond_to_assignment", { p_order_id: id, p_accept: true, p_expected_status: "confirmed" })).error).toBeNull();
		expect((await tenant.driver.rpc("pick_up_orders", { p_order_ids: [id] })).error).toBeNull();
		const { data: rows } = await tenant.service.from("order_items").select("id, product_id, quantity").eq("order_id", id);
		return { id, items: rows! };
	}

	const deliver = (orderId: string, lines: unknown, outcome = "delivered", failure: string | null = null) =>
		tenant.driver.rpc("record_delivery", {
			p_delivery_id: crypto.randomUUID(), p_order_id: orderId, p_outcome: outcome, p_lines: lines as never,
			p_receiver_name: null, p_signature_path: null, p_photo_path: null, p_failure_reason: failure, p_failure_note: null,
			p_payment_method: null, p_amount_collected: null,
		} as never);

	it("receipts add, counts set the stock, and only an admin writes", async () =>
	{
		const p = await product();
		expect((await save([{ product_id: p, kind: "receipt", quantity: 12.5, note: "Factura 1" }])).data).toBe(1);
		expect(await stock(p)).toBe(12.5);
		expect((await save([{ product_id: p, kind: "count", quantity: 10 }])).data).toBe(1);
		expect(await stock(p)).toBe(10);
		expect((await save([{ product_id: p, kind: "count", quantity: 10 }])).data).toBe(0);

		expect((await save([{ product_id: p, kind: "receipt", quantity: 1 }], tenant.operator)).error?.code).toBe("42501");
		expect((await save([{ product_id: p, kind: "receipt", quantity: 0 }])).error?.code).toBe("22023");
		expect((await save([{ product_id: p, kind: "count", quantity: -1 }])).error?.code).toBe("22023");
		expect((await save([{ product_id: p, kind: "receipt", quantity: 1.234 }])).error?.code).toBe("22023");
		const { error } = await tenant.admin.from("inventory_movements")
			.insert({ tenant_id: tenant.tenantId, product_id: p, quantity: 5, kind: "receipt" });
		expect(error).not.toBeNull();
		expect(await stock(p)).toBe(10);
	});

	it("is isolated by tenant and hidden from drivers", async () =>
	{
		const p = await product(5);
		expect((await save([{ product_id: p, kind: "receipt", quantity: 1 }], other.admin)).error?.code).toBe("P0002");
		const { data } = await other.admin.from("inventory_movements").select("id").eq("product_id", p);
		expect(data).toEqual([]);
		const { data: d } = await tenant.driver.from("inventory_movements").select("id").eq("product_id", p);
		expect(d).toEqual([]);
	});

	it("an order takes stock when it leaves, not before, and may go negative", async () =>
	{
		const p = await product(3);
		const { data } = await createOrder(tenant.admin, { customer_id: customerId, notes: "n", items: [{ product_id: p, quantity: 5 }] });
		expect(await stock(p)).toBe(3);
		expect((await tenant.operator.rpc("assign_order", {
			p_order_id: data!.order.id, p_driver_id: tenant.driverId, p_delivery_date: date, p_delivery_window: "AM", p_expected_status: "pending",
		})).error).toBeNull();
		expect(await stock(p)).toBe(3);
		await pickedUp([{ product_id: p, quantity: 5 }]);
		expect(await stock(p)).toBe(-2);
	});

	it("partial delivery: refused comes back, damaged is lost", async () =>
	{
		const [a, b] = [await product(20), await product(20)];
		const { id, items } = await pickedUp([{ product_id: a, quantity: 10 }, { product_id: b, quantity: 10 }]);
		expect([await stock(a), await stock(b)]).toEqual([10, 10]);
		const lines = items.map((i) => ({
			order_item_id: i.id, delivered_quantity: 7, reason: i.product_id === a ? "refused" : "damaged",
		}));
		expect((await deliver(id, lines)).error).toBeNull();
		expect([await stock(a), await stock(b)]).toEqual([13, 10]);
	});

	it("a failed delivery returns everything; cancelling after it changes nothing", async () =>
	{
		const p = await product(10);
		const { id } = await pickedUp([{ product_id: p, quantity: 4 }]);
		expect(await stock(p)).toBe(6);
		expect((await deliver(id, [], "failed", "customer_closed")).error).toBeNull();
		expect(await stock(p)).toBe(10);
		expect((await tenant.operator.rpc("cancel_order", {
			p_order_id: id, p_reason: "customer_closed", p_note: "", p_expected_status: "delivery_failed",
		})).error).toBeNull();
		expect(await stock(p)).toBe(10);
	});

	it("an admin correction moves stock to match the new status", async () =>
	{
		const p = await product(10);
		const { id } = await pickedUp([{ product_id: p, quantity: 4 }]);
		expect((await tenant.admin.rpc("correct_order_status", {
			p_order_id: id, p_status: "confirmed", p_reason: "error", p_expected_status: "dispatched",
		})).error).toBeNull();
		expect(await stock(p)).toBe(10);
		expect((await tenant.admin.rpc("correct_order_status", {
			p_order_id: id, p_status: "delivered", p_reason: "error", p_expected_status: "confirmed",
		})).error).toBeNull();
		expect(await stock(p)).toBe(6);
		const { data } = await tenant.operator.from("inventory_movements").select("quantity, kind, order_id").eq("product_id", p).order("created_at");
		expect(data!.map((m) => [m.kind, Number(m.quantity)])).toEqual([["count", 10], ["order", -4], ["order", 4], ["order", -4]]);
	});
});
