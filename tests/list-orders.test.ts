import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { listOrders, quickAddCustomer, quickAddProduct, type OrdersCursor } from "@/lib/supabase/queries";

describe("listOrders()", () =>
{
	let tenant: TestTenant;
	let customerId: string;
	let productId: string;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "List Orders Customer"),
			quickAddProduct(tenant.admin, "List Orders Product"),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	async function insertOrder(createdAt: Date): Promise<string>
	{
		const { data, error } = await tenant.admin
			.from("orders")
			.insert({
				tenant_id: tenant.tenantId,
				customer_id: customerId,
				notes: "pagination fixture",
				created_at: createdAt.toISOString(),
			})
			.select("id")
			.single();
		if (error)
		{
			throw new Error(`fixture insert failed: ${error.message}`);
		}
		// tenant_id is NOT NULL in the generated Insert type, but the
		// order_items_set_tenant_id trigger always overwrites it from the
		// parent order before the constraint is checked (T2) — any syntactically
		// valid value here just satisfies TypeScript, it's never what lands.
		await tenant.admin
			.from("order_items")
			.insert({ order_id: data.id, product_id: productId, quantity: 1, tenant_id: tenant.tenantId });
		return data.id;
	}

	describe("basic paging", () =>
	{
		// 7 orders, strictly increasing created_at, oldest first — descending
		// order means ids[6] is newest (page 1) and ids[0] is oldest (last page).
		let ids: string[];

		beforeAll(async () =>
		{
			const base = new Date(2026, 1, 1, 0, 0, 0);
			ids = [];
			for (let i = 0; i < 7; i++)
			{
				const createdAt = new Date(base.getTime() + i * 60_000);
				ids.push(await insertOrder(createdAt));
			}
		});

		it("first page (no cursor) returns the newest orders, correct nextCursor", async () =>
		{
			const { data, error } = await listOrders(tenant.admin, { limit: 3 });
			expect(error).toBeNull();
			expect(data!.orders.map((o) => o.id)).toEqual([ids[6], ids[5], ids[4]]);
			expect(data!.nextCursor).not.toBeNull();
		});

		it("'load more' across 3 pages returns every order exactly once, no duplicates or gaps", async () =>
		{
			const seen: string[] = [];
			let cursor: OrdersCursor | undefined;

			for (let page = 0; page < 5; page++)
			{
				const { data, error } = await listOrders(tenant.admin, { limit: 3, cursor });
				expect(error).toBeNull();
				seen.push(...data!.orders.map((o) => o.id));
				cursor = data!.nextCursor ?? undefined;
				if (!cursor)
				{
					break;
				}
			}

			// Only compare against the 7 fixture ids from this describe block —
			// other describe blocks in this file create their own orders too.
			const seenFixtureIds = seen.filter((id) => ids.includes(id));
			expect(seenFixtureIds).toHaveLength(7);
			expect(new Set(seenFixtureIds).size).toBe(7); // no duplicates
			expect(seenFixtureIds).toEqual([...ids].reverse()); // newest-first, no gaps
		});

		it("last page has nextCursor: null", async () =>
		{
			// limit large enough to exhaust all 7 (plus whatever earlier tests
			// in this suite created) in one page.
			const { data, error } = await listOrders(tenant.admin, { limit: 100 });
			expect(error).toBeNull();
			expect(data!.nextCursor).toBeNull();
		});
	});

	describe("tie-break on identical created_at", () =>
	{
		const tied = new Date(2026, 1, 10, 0, 0, 0);
		let firstId: string;
		let secondId: string;

		beforeAll(async () =>
		{
			firstId = await insertOrder(tied);
			secondId = await insertOrder(tied);
		});

		it("both orders are returned across pages, none dropped", async () =>
		{
			const { data: page1, error: error1 } = await listOrders(tenant.admin, { limit: 1, cursor: undefined });
			expect(error1).toBeNull();
			expect(page1!.orders).toHaveLength(1);
			expect(page1!.nextCursor).not.toBeNull();

			// Keep paging with limit 1 until we've seen both tied ids or run out.
			const seen = new Set(page1!.orders.map((o) => o.id));
			let cursor = page1!.nextCursor;
			for (let i = 0; i < 20 && cursor && !(seen.has(firstId) && seen.has(secondId)); i++)
			{
				const { data } = await listOrders(tenant.admin, { limit: 1, cursor });
				data!.orders.forEach((o) => seen.add(o.id));
				cursor = data!.nextCursor;
			}

			expect(seen.has(firstId)).toBe(true);
			expect(seen.has(secondId)).toBe(true);
		});
	});

	describe("malformed cursor", () =>
	{
		it("rejects a non-UUID id without reaching PostgREST", async () =>
		{
			const { data, error } = await listOrders(tenant.admin, {
				cursor: { createdAt: new Date().toISOString(), id: "not-a-uuid" },
			});
			expect(data).toBeNull();
			expect(error?.code).toBe("22023");
		});

		it("rejects an unparseable createdAt", async () =>
		{
			const { data, error } = await listOrders(tenant.admin, {
				cursor: { createdAt: "not-a-date", id: crypto.randomUUID() },
			});
			expect(data).toBeNull();
			expect(error?.code).toBe("22023");
		});
	});
});
