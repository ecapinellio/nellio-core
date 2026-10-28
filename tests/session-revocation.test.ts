import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { quickAddCustomer } from "@/lib/supabase/queries";

// public.tenant_id() fails closed once the caller's session is dead
// (session row deleted by a password change, or user banned). Each test
// kills a different fixture user's session, so they get a tenant each.
//
// The fixture clients don't auto-refresh, so after the kill they keep
// sending the same, still-unexpired access token — exactly what someone
// holding a copied token would do against PostgREST directly.

const service = createClient<Database>(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
	{ auth: { autoRefreshToken: false, persistSession: false } },
);

describe("tenant_id() session revocation", () =>
{
	let tenant: TestTenant;

	beforeAll(async () =>
	{
		tenant = await setupTenant();
		await quickAddCustomer(tenant.admin, "Revocation Customer");
	});

	afterAll(async () =>
	{
		await tenant.teardown();
	});

	it("a live session still sees its tenant's data (regression)", async () =>
	{
		const { data, error } = await tenant.admin.from("customers").select("id");
		expect(error).toBeNull();
		expect(data).toHaveLength(1);
	});

	it("after a password change, the old access token sees nothing and can't write", async () =>
	{
		const before = await tenant.operator.from("customers").select("id");
		expect(before.data).toHaveLength(1);

		await service.auth.admin.updateUserById(tenant.operatorId, { password: "Rotated-Pass-2026!" });

		const after = await tenant.operator.from("customers").select("id");
		expect(after.error).toBeNull();
		expect(after.data).toEqual([]);

		const write = await quickAddCustomer(tenant.operator, "Should Not Exist");
		expect(write.error).not.toBeNull();

		const tenantRow = await tenant.operator.from("tenants").select("id");
		expect(tenantRow.data).toEqual([]);
	});

	it("after a ban, the old access token sees nothing", async () =>
	{
		const before = await tenant.driver.from("users").select("id");
		expect(before.data!.length).toBeGreaterThan(0);

		await service.auth.admin.updateUserById(tenant.driverId, { ban_duration: "876000h" });

		const after = await tenant.driver.from("users").select("id");
		expect(after.error).toBeNull();
		expect(after.data).toEqual([]);
	});

	it("the admin's own session is unaffected by other users' revocations", async () =>
	{
		const { data } = await tenant.admin.from("customers").select("id");
		expect(data).toHaveLength(1);
	});
});
