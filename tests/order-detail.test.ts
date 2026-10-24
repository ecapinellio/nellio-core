import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createOrder, getOrderDetail, quickAddCustomer, quickAddProduct, updateOrderDetail } from "@/lib/supabase/queries";

describe("getOrderDetail() / updateOrderDetail() / update_order_detail() RPC", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	let customerId: string;
	let productId: string;

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);
		const [{ data: customer }, { data: product }] = await Promise.all([
			quickAddCustomer(tenant.admin, "Order Detail Customer"),
			quickAddProduct(tenant.admin, "Order Detail Product", { pricePerUnit: 10, unit: "kg" }),
		]);
		customerId = customer!.id;
		productId = product!.id;
	});

	afterAll(async () =>
	{
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	async function freshOrder()
	{
		const { data } = await createOrder(tenant.admin, {
			customer_id: customerId,
			notes: "original notes",
			items: [{ product_id: productId, quantity: 2 }],
		});
		return { orderId: data!.order.id, itemId: data!.items[0].id };
	}

	describe("getOrderDetail()", () =>
	{
		it("returns full order detail with embedded customer, product, and no override (fresh order)", async () =>
		{
			const { orderId } = await freshOrder();
			const { data, error } = await getOrderDetail(tenant.admin, orderId);

			expect(error).toBeNull();
			expect(data?.customerName).toBe("Order Detail Customer");
			expect(data?.notes).toBe("original notes");
			expect(data?.items).toHaveLength(1);
			expect(data?.items[0].productName).toBe("Order Detail Product");
			expect(data?.items[0].priceAtOrder).toBe(10);
			// create_order()'s initial snapshot is not an override (eng-review Decision 10).
			expect(data?.items[0].priceOverriddenBy).toBeNull();
			expect(data?.items[0].priceOverriddenByName).toBeNull();
			expect(data?.items[0].priceOverriddenAt).toBeNull();
		});

		it("returns an error for a nonexistent order", async () =>
		{
			const { data, error } = await getOrderDetail(tenant.admin, crypto.randomUUID());
			expect(data).toBeNull();
			expect(error?.code).toBe("PGRST116");
		});

		it("driver cannot see order detail (RLS)", async () =>
		{
			const { orderId } = await freshOrder();
			const { data, error } = await getOrderDetail(tenant.driver, orderId);
			expect(data).toBeNull();
			expect(error?.code).toBe("PGRST116");
		});
	});

	describe("updateOrderDetail() / update_order_detail() RPC", () =>
	{
		it("happy path: notes + price update applied atomically, resolves the overriding user's name", async () =>
		{
			const { orderId, itemId } = await freshOrder();

			const { data, error } = await updateOrderDetail(tenant.admin, orderId, {
				notes: "corrected notes",
				priceUpdates: [{ orderItemId: itemId, priceAtOrder: 15 }],
			});
			expect(error).toBeNull();
			expect(data?.order.notes).toBe("corrected notes");
			expect(data?.items[0].price_at_order).toBe(15);

			const { data: detail } = await getOrderDetail(tenant.admin, orderId);
			expect(detail?.notes).toBe("corrected notes");
			expect(detail?.items[0].priceAtOrder).toBe(15);
			expect(detail?.items[0].priceOverriddenByName).toBe("Test admin");
			expect(detail?.items[0].priceOverriddenAt).not.toBeNull();
		});

		it("notes-only update leaves price_at_order and override columns untouched", async () =>
		{
			const { orderId } = await freshOrder();
			const { error } = await updateOrderDetail(tenant.admin, orderId, { notes: "just notes", priceUpdates: [] });
			expect(error).toBeNull();

			const { data: detail } = await getOrderDetail(tenant.admin, orderId);
			expect(detail?.notes).toBe("just notes");
			expect(detail?.items[0].priceAtOrder).toBe(10);
			expect(detail?.items[0].priceOverriddenBy).toBeNull();
		});

		it("price-only update (null notes) clears notes, same as create_order()'s own normalization", async () =>
		{
			const { orderId, itemId } = await freshOrder();
			const { error } = await updateOrderDetail(tenant.admin, orderId, {
				notes: null,
				priceUpdates: [{ orderItemId: itemId, priceAtOrder: 20 }],
			});
			expect(error).toBeNull();

			const { data: detail } = await getOrderDetail(tenant.admin, orderId);
			expect(detail?.notes).toBeNull();
			expect(detail?.items[0].priceAtOrder).toBe(20);
		});

		it("rejects price_at_order <= 0", async () =>
		{
			const { orderId, itemId } = await freshOrder();
			const { error } = await updateOrderDetail(tenant.admin, orderId, {
				notes: null,
				priceUpdates: [{ orderItemId: itemId, priceAtOrder: 0 }],
			});
			expect(error?.code).toBe("22003");
		});

		it("rejects an order_item_id that belongs to a DIFFERENT order (cross-order tampering guard)", async () =>
		{
			const { orderId: orderA } = await freshOrder();
			const { itemId: itemFromOrderB } = await freshOrder();

			const { error } = await updateOrderDetail(tenant.admin, orderA, {
				notes: null,
				priceUpdates: [{ orderItemId: itemFromOrderB, priceAtOrder: 99 }],
			});
			expect(error?.code).toBe("P0002");
		});

		it("rejects a cross-tenant order_id", async () =>
		{
			const { data: otherCustomer } = await quickAddCustomer(otherTenant.admin, "Other Tenant Customer");
			const { data: otherProduct } = await quickAddProduct(otherTenant.admin, "Other Tenant Product");
			const { data: otherOrder } = await createOrder(otherTenant.admin, {
				customer_id: otherCustomer!.id,
				notes: "other tenant's order",
				items: [{ product_id: otherProduct!.id, quantity: 1 }],
			});

			const { error } = await updateOrderDetail(tenant.admin, otherOrder!.order.id, { notes: "hijacked", priceUpdates: [] });
			expect(error?.code).toBe("P0002");
		});

		it("rejects a nonexistent order_id", async () =>
		{
			const { error } = await updateOrderDetail(tenant.admin, crypto.randomUUID(), { notes: null, priceUpdates: [] });
			expect(error?.code).toBe("P0002");
		});

		it("driver is blocked with an explicit error — not a silent no-op success (eng-review Decision 4)", async () =>
		{
			const { orderId, itemId } = await freshOrder();
			const { error } = await updateOrderDetail(tenant.driver, orderId, {
				notes: "hacked by driver",
				priceUpdates: [{ orderItemId: itemId, priceAtOrder: 1 }],
			});
			expect(error?.code).toBe("42501");

			const { data: detail } = await getOrderDetail(tenant.admin, orderId);
			expect(detail?.notes).toBe("original notes");
			expect(detail?.items[0].priceAtOrder).toBe(10);
		});
	});
});
