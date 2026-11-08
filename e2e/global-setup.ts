import { mkdirSync, writeFileSync } from "node:fs";
import type { User } from "@supabase/supabase-js";
import { setupTenant, TEST_PASSWORD } from "@/tests/integration/fixtures";
import { createOrder, quickAddCustomer, quickAddProduct } from "@/lib/supabase/queries";
import { SEED_FILE, type Seed } from "./seed";

/**
 * One real tenant (admin/operator/driver) for the whole e2e run — same
 * fixture as the integration suite, so the local-only guard applies.
 * Returns the teardown Playwright runs after the last test.
 */
export default async function globalSetup()
{
	const tenant = await setupTenant();

	const ok = <T>(r: { data: T; error: { message: string } | null }): NonNullable<T> =>
	{
		if (r.error || r.data == null)
		{
			throw new Error(`e2e seed failed: ${r.error?.message}`);
		}
		return r.data;
	};

	const customer = ok(await quickAddCustomer(tenant.admin, "Cliente E2E"));
	const product = ok(await quickAddProduct(tenant.admin, "Producto E2E", { pricePerUnit: 12.5, unit: "gal" }));
	ok(await tenant.service.from("customers").update({ address: "Calle E2E 1", phone: "7000-0000" }).eq("id", customer.id).select());

	// An order assigned to the driver: what /deliveries and /t/<token> show.
	const order = ok(await createOrder(tenant.admin, {
		customer_id: customer.id, notes: "pedido e2e asignado", items: [{ product_id: product.id, quantity: 3 }],
	})).order;
	ok(await tenant.operator.rpc("assign_order", {
		p_order_id: order.id, p_driver_id: tenant.driverId, p_delivery_date: new Date().toISOString().slice(0, 10),
		p_delivery_window: "AM", p_expected_status: "pending",
	}));
	const { tracking_token } = ok(await tenant.service.from("orders").select("tracking_token").eq("id", order.id).single());

	// Own user for the logout test: signOut() revokes every session of the
	// user (scope "global"), which would kill the shared operator's storageState.
	const logoutEmail = tenant.emails.operator.replace("operator+", "logout+");
	const logoutUser = ok<{ user: User | null }>(await tenant.service.auth.admin.createUser({
		email: logoutEmail, password: TEST_PASSWORD, email_confirm: true,
		app_metadata: { tenant_id: tenant.tenantId, role: "operator" },
	})).user!;
	ok(await tenant.service.from("users").insert({ id: logoutUser.id, tenant_id: tenant.tenantId, name: "Logout operator", role: "operator" }).select());

	const seed: Seed = {
		emails: tenant.emails,
		logoutEmail,
		customerName: "Cliente E2E",
		productName: "Producto E2E",
		assignedOrderId: order.id,
		trackingToken: tracking_token,
	};
	mkdirSync("e2e/.auth", { recursive: true });
	writeFileSync(SEED_FILE, JSON.stringify(seed, null, "\t"));

	return async () =>
	{
		await tenant.service.auth.admin.deleteUser(logoutUser.id);
		await tenant.teardown();
	};
}
