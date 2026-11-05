import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { assignOrder, pickUpOrders, recordDelivery, respondToAssignment, uploadDeliveryProof } from "@/lib/orders/actions-client";
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

		// Two people with the same order open (ADR-010 makes the board live; the
		// detail panel still saves what it loaded). Only the fields this panel
		// changed are written, and each must still hold what it loaded.
		describe("concurrent edits", () =>
		{
			it("a price-only save leaves a colleague's new notes alone", async () =>
			{
				const { orderId, itemId } = await freshOrder();
				expect((await updateOrderDetail(tenant.operator, orderId, { notes: "colleague's notes", priceUpdates: [] })).error).toBeNull();

				const { error } = await updateOrderDetail(tenant.admin, orderId, {
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 12, expectedPriceAtOrder: 10 }],
				});
				expect(error).toBeNull();

				const { data: detail } = await getOrderDetail(tenant.admin, orderId);
				expect(detail?.notes).toBe("colleague's notes");
				expect(detail?.items[0].priceAtOrder).toBe(12);
			});

			it("rejects notes a colleague changed meanwhile, writing nothing", async () =>
			{
				const { orderId, itemId } = await freshOrder();
				expect((await updateOrderDetail(tenant.operator, orderId, { notes: "colleague's notes", priceUpdates: [] })).error).toBeNull();

				const { error } = await updateOrderDetail(tenant.admin, orderId, {
					notes: "my notes",
					expectedNotes: "original notes",
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 13, expectedPriceAtOrder: 10 }],
				});
				expect(error?.code).toBe("PT409");

				const { data: detail } = await getOrderDetail(tenant.admin, orderId);
				expect(detail?.notes).toBe("colleague's notes");
				expect(detail?.items[0].priceAtOrder).toBe(10);
			});

			it("rejects a price a colleague changed meanwhile", async () =>
			{
				const { orderId, itemId } = await freshOrder();
				expect((await updateOrderDetail(tenant.operator, orderId, {
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 11, expectedPriceAtOrder: 10 }],
				})).error).toBeNull();

				const { error } = await updateOrderDetail(tenant.admin, orderId, {
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 14, expectedPriceAtOrder: 10 }],
				});
				expect(error?.code).toBe("PT409");
				expect((await getOrderDetail(tenant.admin, orderId)).data?.items[0].priceAtOrder).toBe(11);
			});

			it("a status move by a colleague is not a conflict", async () =>
			{
				const { orderId } = await freshOrder();
				expect((await tenant.service.from("orders").update({ status: "confirmed" }).eq("id", orderId)).error).toBeNull();

				const { error } = await updateOrderDetail(tenant.admin, orderId, {
					notes: "my notes",
					expectedNotes: "original notes",
					priceUpdates: [],
				});
				expect(error).toBeNull();
				expect((await getOrderDetail(tenant.admin, orderId)).data?.notes).toBe("my notes");
			});

			it("a first price on a line without one checks against null", async () =>
			{
				const { data: unpriced } = await quickAddProduct(tenant.admin, `Unpriced ${crypto.randomUUID()}`);
				const { data } = await createOrder(tenant.admin, {
					customer_id: customerId,
					notes: null,
					items: [{ product_id: unpriced!.id, quantity: 1 }],
				});
				const itemId = data!.items[0].id;

				expect((await updateOrderDetail(tenant.admin, data!.order.id, {
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 5, expectedPriceAtOrder: null }],
				})).error).toBeNull();
				expect((await updateOrderDetail(tenant.admin, data!.order.id, {
					priceUpdates: [{ orderItemId: itemId, priceAtOrder: 6, expectedPriceAtOrder: null }],
				})).error?.code).toBe("PT409");
			});
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

	describe("getOrderDetail() fulfillment fields", () =>
	{
		it("returns driver, schedule, invoice status, the event trail and the delivery with signed proof URLs", async () =>
		{
			const { orderId, itemId } = await freshOrder();
			expect((await assignOrder(tenant.operator, orderId, {
				driverId: tenant.driverId, deliveryDate: "2026-11-10", deliveryWindow: "AM", expectedStatus: "pending",
			})).error).toBeNull();
			expect((await respondToAssignment(tenant.driver, orderId, true, "confirmed")).error).toBeNull();
			expect((await pickUpOrders(tenant.driver, [orderId])).error).toBeNull();

			const deliveryId = crypto.randomUUID();
			const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
			const { data: path, error: uploadError } = await uploadDeliveryProof(tenant.driver, tenant.tenantId, deliveryId, "signature", png);
			expect(uploadError).toBeNull();
			expect(path).toBe(`${tenant.tenantId}/${deliveryId}/signature.png`);

			const { error } = await recordDelivery(tenant.driver, orderId, {
				deliveryId,
				outcome: "delivered",
				lines: [{ orderItemId: itemId, deliveredQuantity: 2 }],
				receiverName: "Juan",
				signaturePath: path,
				photoPath: null,
				failureReason: null,
				failureNote: null,
				paymentMethod: "cash",
				amountCollected: 20,
			});
			expect(error).toBeNull();

			const { data, error: detailError } = await getOrderDetail(tenant.operator, orderId);
			expect(detailError).toBeNull();
			expect(data).toMatchObject({ status: "delivered", deliveryDate: "2026-11-10", deliveryWindow: "AM", invoiceStatus: "pending" });
			expect(data?.driver).not.toBeNull();
			expect(data?.events.map((e) => e.action)).toEqual(["create", "assign", "accept", "pick_up", "deliver"]);
			expect(data?.events[1].actorName).not.toBeNull();
			expect(data?.delivery).toMatchObject({ receiverName: "Juan", paymentMethod: "cash", amountCollected: 20, outcome: "delivered", photoUrl: null });
			const response = await fetch(data!.delivery!.signatureUrl!);
			expect(response.status).toBe(200);
		});

		it("an order with no delivery has delivery null and no driver", async () =>
		{
			const { orderId } = await freshOrder();
			const { data } = await getOrderDetail(tenant.operator, orderId);
			expect(data?.delivery).toBeNull();
			expect(data?.driver).toBeNull();
			expect(data?.events.map((e) => e.action)).toEqual(["create"]);
		});
	});
});
