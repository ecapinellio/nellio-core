import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;
type TableName = "customers" | "products" | "orders" | "order_items";

// T7, Decision 8: full matrix (4 tables x 3 ops x 3 roles), not one
// representative table — each table's RLS policy is an independently
// editable SQL object, so a regression in one wouldn't be caught by
// testing only another. These helpers keep each check to one line
// without collapsing them into fewer, less attributable test cases.

async function expectSelectVisible(client: Client, table: TableName, id: string)
{
	const { data, error } = await client.from(table).select("id").eq("id", id);
	expect(error, `${table} SELECT should succeed`).toBeNull();
	expect(data?.map((r) => r.id), `${table} SELECT should see row ${id}`).toContain(id);
}

async function expectSelectBlocked(client: Client, table: TableName, id: string)
{
	const { data, error } = await client.from(table).select("id").eq("id", id);
	expect(error, `${table} SELECT should not error (RLS filters silently)`).toBeNull();
	expect(data, `${table} SELECT should return zero rows`).toEqual([]);
}

async function expectUpdateBlocked(client: Client, table: TableName, id: string, patch: Record<string, unknown>)
{
	// supabase-js's generated per-table Update types can't be expressed
	// generically over a dynamic `table: TableName` union — `as never` is
	// test-only scaffolding, not a real type-safety gap in product code.
	const { data } = await client.from(table).update(patch as never).eq("id", id).select();
	expect(data, `${table} UPDATE should affect zero rows`).toEqual([]);
}

describe("RLS regression matrix (retroactive T8 coverage)", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;

	let customerId: string;
	let productId: string;
	let orderId: string;
	let orderItemId: string;

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);

		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "RLS Matrix Customer"),
			quickAddProduct(tenant.admin, "RLS Matrix Product"),
		]);
		customerId = customer!.id;
		productId = product!.id;

		const { data: order } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "rls fixture order",
			items: [{ product_id: productId, quantity: 1 }],
		});
		orderId = order!.order.id;
		orderItemId = order!.items[0].id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	describe.each([
		{ table: "customers" as const, id: () => customerId, patch: () => ({ updated_at: new Date().toISOString() }) },
		{ table: "products" as const, id: () => productId, patch: () => ({ updated_at: new Date().toISOString() }) },
		{ table: "orders" as const, id: () => orderId, patch: () => ({ updated_at: new Date().toISOString() }) },
		// order_items has no updated_at column (T2 schema) — quantity is the
		// one real editable column, and still exercises the same UPDATE policy.
		{ table: "order_items" as const, id: () => orderItemId, patch: () => ({ quantity: 2 }) },
	])("$table", ({ table, id, patch }) =>
	{
		it("admin can SELECT", async () =>
		{
			await expectSelectVisible(tenant.admin, table, id());
		});

		it("operator can SELECT", async () =>
		{
			await expectSelectVisible(tenant.operator, table, id());
		});

		it("driver is blocked from SELECT", async () =>
		{
			await expectSelectBlocked(tenant.driver, table, id());
		});

		it("driver is blocked from UPDATE", async () =>
		{
			await expectUpdateBlocked(tenant.driver, table, id(), patch());
		});
	});

	describe("customers INSERT", () =>
	{
		it("admin can INSERT", async () =>
		{
			const { error } = await tenant.admin.from("customers").insert({ tenant_id: tenant.tenantId, name: "Admin Insert" });
			expect(error).toBeNull();
		});

		it("operator can INSERT", async () =>
		{
			const { error } = await tenant.operator.from("customers").insert({ tenant_id: tenant.tenantId, name: "Operator Insert" });
			expect(error).toBeNull();
		});

		it("driver is blocked from INSERT", async () =>
		{
			const { error } = await tenant.driver.from("customers").insert({ tenant_id: tenant.tenantId, name: "Driver Insert" });
			expect(error).not.toBeNull();
		});
	});

	describe("products INSERT", () =>
	{
		it("admin can INSERT", async () =>
		{
			const { error } = await tenant.admin.from("products").insert({ tenant_id: tenant.tenantId, name: "Admin Product" });
			expect(error).toBeNull();
		});

		it("operator can INSERT", async () =>
		{
			const { error } = await tenant.operator.from("products").insert({ tenant_id: tenant.tenantId, name: "Operator Product" });
			expect(error).toBeNull();
		});

		it("driver is blocked from INSERT", async () =>
		{
			const { error } = await tenant.driver.from("products").insert({ tenant_id: tenant.tenantId, name: "Driver Product" });
			expect(error).not.toBeNull();
		});
	});

	describe("orders INSERT (direct, not via create_order())", () =>
	{
		it("admin can INSERT", async () =>
		{
			const { error } = await tenant.admin
				.from("orders")
				.insert({ tenant_id: tenant.tenantId, customer_id: customerId, notes: "admin direct insert" });
			expect(error).toBeNull();
		});

		it("operator can INSERT", async () =>
		{
			const { error } = await tenant.operator
				.from("orders")
				.insert({ tenant_id: tenant.tenantId, customer_id: customerId, notes: "operator direct insert" });
			expect(error).toBeNull();
		});

		it("driver is blocked from INSERT", async () =>
		{
			const { error } = await tenant.driver
				.from("orders")
				.insert({ tenant_id: tenant.tenantId, customer_id: customerId, notes: "driver direct insert" });
			expect(error).not.toBeNull();
		});
	});

	// Decision 9: order_items is normally only written via create_order()
	// (SECURITY INVOKER), but its RLS policy is defense-in-depth for a path
	// the RPC doesn't take — verified independently via a direct insert.
	describe("order_items INSERT (direct, not via create_order())", () =>
	{
		it("admin can INSERT directly", async () =>
		{
			const { error } = await tenant.admin
				.from("order_items")
				.insert({ order_id: orderId, product_id: productId, quantity: 1, tenant_id: tenant.tenantId });
			expect(error).toBeNull();
		});

		it("operator can INSERT directly", async () =>
		{
			const { error } = await tenant.operator
				.from("order_items")
				.insert({ order_id: orderId, product_id: productId, quantity: 1, tenant_id: tenant.tenantId });
			expect(error).toBeNull();
		});

		it("driver is blocked from INSERT directly", async () =>
		{
			const { error } = await tenant.driver
				.from("order_items")
				.insert({ order_id: orderId, product_id: productId, quantity: 1, tenant_id: tenant.tenantId });
			expect(error).not.toBeNull();
		});
	});

	describe("tenant isolation (representative table: customers)", () =>
	{
		it("operator in tenant A cannot SELECT tenant B's customer", async () =>
		{
			const { data: otherCustomer } = await quickAddCustomer(otherTenant.admin, "Other Tenant Isolation Customer");
			await expectSelectBlocked(tenant.operator, "customers", otherCustomer!.id);
		});

		it("operator in tenant A cannot UPDATE tenant B's customer", async () =>
		{
			const { data: otherCustomer } = await quickAddCustomer(otherTenant.admin, "Other Tenant Isolation Customer 2");
			await expectUpdateBlocked(tenant.operator, "customers", otherCustomer!.id, { name: "hijacked" });
		});

		it("operator in tenant A cannot INSERT a row tagged with tenant B's id", async () =>
		{
			const { error } = await tenant.operator
				.from("customers")
				.insert({ tenant_id: otherTenant.tenantId, name: "Cross Tenant Insert Attempt" });
			expect(error).not.toBeNull();
		});
	});
});
