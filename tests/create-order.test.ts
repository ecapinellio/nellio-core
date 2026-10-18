import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import type { Database } from "@/lib/supabase/database.types";

describe("createOrder() / create_order() RPC", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	let customerId: string;
	let productId: string;
	let pricedProductId: string;

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);

		const [{ data: customer }, { data: product }, { data: pricedProduct }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Create Order Customer"),
			quickAddProduct(tenant.admin, "Create Order Product"),
			quickAddProduct(tenant.admin, "Priced Product", { pricePerUnit: 15.5, unit: "kg" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
		pricedProductId = pricedProduct!.id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	async function countOrdersForCustomer(custId: string): Promise<number>
	{
		const { data, error } = await tenant.admin.from("orders").select("id").eq("customer_id", custId);
		if (error)
		{
			throw new Error(`count query failed: ${error.message}`);
		}
		return data.length;
	}

	it("happy path creates an order and its items atomically", async () =>
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "2 bidones de cloro",
			items: [{ product_id: productId, quantity: 2 }],
		});

		expect(error).toBeNull();
		expect(data?.order.customer_id).toBe(customerId);
		expect(data?.items).toHaveLength(1);
		expect(data?.items[0].quantity).toBe(2);
	});

	it("S3a: snapshots price_at_order/unit_at_order from the product at creation time (priced product)", async () =>
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "priced product",
			items: [{ product_id: pricedProductId, quantity: 3 }],
		});

		expect(error).toBeNull();
		expect(data?.items[0].price_at_order).toBe(15.5);
		expect(data?.items[0].unit_at_order).toBe("kg");
	});

	it("S3a: price_at_order/unit_at_order are null for a product with no price set", async () =>
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "unpriced product",
			items: [{ product_id: productId, quantity: 1 }],
		});

		expect(error).toBeNull();
		expect(data?.items[0].price_at_order).toBeNull();
		expect(data?.items[0].unit_at_order).toBeNull();
	});

	it("S3a: the snapshot does not change later if the product's price changes (immutability)", async () =>
	{
		const { data: drifted } = await quickAddProduct(tenant.admin, "Drift Product", { pricePerUnit: 20, unit: "l" });

		const { data: created } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "drift check",
			items: [{ product_id: drifted!.id, quantity: 1 }],
		});
		expect(created?.items[0].price_at_order).toBe(20);

		await tenant.admin.from("products").update({ price_per_unit: 99 }).eq("id", drifted!.id);

		const { data: reread } = await tenant.admin
			.from("order_items")
			.select("price_at_order")
			.eq("id", created!.items[0].id)
			.single();
		expect(reread?.price_at_order).toBe(20);
	});

	it("rejects a null customer_id", async () =>
	{
		// null (not undefined): JSON.stringify drops undefined properties
		// entirely, so the RPC call would omit p_customer_id and fail at
		// PostgREST's function-matching layer (PGRST202) instead of ever
		// reaching the RPC's own "customer_id is required" (22004) check.
		const { error } = await createOrder(tenant.admin, {
			customer_id: null as unknown as string,
			notes: "x",
			items: [{ product_id: productId, quantity: 1 }],
		});
		expect(error?.code).toBe("22004");
	});

	it("accepts blank notes, normalized to null (slice 2: notes is optional)", async () =>
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "   ",
			items: [{ product_id: productId, quantity: 1 }],
		});
		expect(error).toBeNull();
		expect(data?.order.notes).toBeNull();
	});

	it("accepts null notes directly", async () =>
	{
		const { data, error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: null,
			items: [{ product_id: productId, quantity: 1 }],
		});
		expect(error).toBeNull();
		expect(data?.order.notes).toBeNull();
	});

	it("rejects an empty items array", async () =>
	{
		const { error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "x",
			items: [],
		});
		expect(error?.code).toBe("22004");
	});

	it("rejects an item missing product_id/quantity", async () =>
	{
		const { error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "x",
			// @ts-expect-error -- deliberately malformed item
			items: [{ product_id: productId }],
		});
		expect(error?.code).toBe("22004");
	});

	it("rejects quantity <= 0", async () =>
	{
		const { error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "x",
			items: [{ product_id: productId, quantity: 0 }],
		});
		expect(error?.code).toBe("22003");
	});

	it("rejects a cross-tenant customer_id", async () =>
	{
		const { data: otherCustomer } = await quickAddCustomer(otherTenant.admin, "Other Tenant Customer");
		const { error } = await createOrder(tenant.admin, {
			customer_id: otherCustomer!.id,
			notes: "x",
			items: [{ product_id: productId, quantity: 1 }],
		});
		expect(error?.code).toBe("P0002");
	});

	it("rejects a cross-tenant product_id mid-array and creates ZERO order rows (atomicity)", async () =>
	{
		const { data: otherProduct } = await quickAddProduct(otherTenant.admin, "Other Tenant Product");
		const before = await countOrdersForCustomer(customerId);

		const { error } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "atomicity check",
			items: [
				{ product_id: productId, quantity: 1 },
				{ product_id: otherProduct!.id, quantity: 1 },
			],
		});

		expect(error?.code).toBe("P0002");
		const after = await countOrdersForCustomer(customerId);
		expect(after).toBe(before);
	});

	it("rejects a client with no session (anon role has no EXECUTE grant)", async () =>
	{
		// 42501 (insufficient_privilege), not 28000: create_order() is only
		// GRANTed to `authenticated` (confirmed in the migration), so a
		// fully anonymous caller is rejected by Postgres before the function
		// body — and its "Not authenticated" (28000) check — ever runs.
		// 28000 is for a *technically authenticated* session with no valid
		// tenant_id (e.g. an expired JWT, per capture-form.tsx's own
		// error handling), which isn't reproducible with a plain anon client.
		const anon = createClient<Database>(
			process.env.NEXT_PUBLIC_SUPABASE_URL!,
			process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
			{ auth: { autoRefreshToken: false, persistSession: false } },
		);

		const { error } = await createOrder(anon, {
			customer_id: customerId,
			notes: "x",
			items: [{ product_id: productId, quantity: 1 }],
		});
		expect(error?.code).toBe("42501");
	});
});
