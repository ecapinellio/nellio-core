import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type Role = "admin" | "operator" | "driver";
type Client = SupabaseClient<Database>;

export interface TestTenant
{
	tenantId: string;
	admin: Client;
	operator: Client;
	driver: Client;
	adminId: string;
	operatorId: string;
	driverId: string;
	teardown: () => Promise<void>;
}

// Meets the password rules (upper, lower, digit, symbol) that Supabase Auth
// now enforces even on admin-created users.
const TEST_PASSWORD = "Nellio-Test-Pass-2026!";

function requireEnv(name: string): string
{
	const value = process.env[name];
	if (!value)
	{
		throw new Error(`Missing required env var: ${name} (see tests/setup.ts)`);
	}
	return value;
}

/**
 * T7, Decision 5: the suite creates and deletes real tenants/users via
 * service_role. This is the one line standing between a misconfigured
 * .env.local and running destructive test setup against a real project.
 */
function assertLocalSupabase(url: string): void
{
	if (!url.includes("127.0.0.1") && !url.includes("localhost"))
	{
		throw new Error(
			`Refusing to run tests against a non-local Supabase URL: ${url}\n` +
			"tests/fixtures.ts creates and deletes real tenants via service_role — " +
			"NEXT_PUBLIC_SUPABASE_URL must point at the local stack (127.0.0.1/localhost).",
		);
	}
}

/**
 * T7, Decision 4: one high-level fixture per test file (Decision 2) —
 * creates a tenant plus admin/operator/driver users, signs each in for
 * real (Decision 3), and returns ready-to-use authenticated clients.
 *
 * Call `teardown()` in `afterAll`. Decision 11: teardown must delete the
 * auth.users rows explicitly — deleting the tenant cascades
 * public.users/customers/products/orders/order_items via their tenant_id
 * FK, but auth.users has no FK back to tenants, so it is never touched by
 * that cascade.
 */
export async function setupTenant(): Promise<TestTenant>
{
	const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
	assertLocalSupabase(url);
	const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
	const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

	const admin = createClient<Database>(url, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	const runId = randomUUID();

	const { data: tenant, error: tenantError } = await admin
		.from("tenants")
		.insert({ name: `Test Tenant ${runId}` })
		.select()
		.single();

	if (tenantError || !tenant)
	{
		throw new Error(`Failed to create test tenant: ${tenantError?.message}`);
	}

	const tenantId = tenant.id;

	// Decision 11: emails are derived from this run's id, not fixed strings
	// — defense in depth so a skipped teardown (e.g. a crashed run) can
	// never collide with the next run's sign-up.
	async function createRoleUser(role: Role): Promise<{ id: string; client: Client }>
	{
		const email = `${role}+${runId}@test.nellio.local`;

		const { data: authUser, error: authError } = await admin.auth.admin.createUser({
			email,
			password: TEST_PASSWORD,
			email_confirm: true,
			app_metadata: { tenant_id: tenantId, role },
		});

		if (authError || !authUser.user)
		{
			throw new Error(`Failed to create ${role} test user: ${authError?.message}`);
		}

		const { error: userRowError } = await admin.from("users").insert({
			id: authUser.user.id,
			tenant_id: tenantId,
			name: `Test ${role}`,
			role,
		});

		if (userRowError)
		{
			throw new Error(`Failed to create ${role} users row: ${userRowError.message}`);
		}

		// A fresh client per role: signInWithPassword mutates the client's own
		// session state, so sharing one client across roles would clobber it.
		const client = createClient<Database>(url, anonKey, {
			auth: { autoRefreshToken: false, persistSession: false },
		});

		const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_PASSWORD });
		if (signInError)
		{
			throw new Error(`Failed to sign in as ${role}: ${signInError.message}`);
		}

		return { id: authUser.user.id, client };
	}

	const [adminUser, operatorUser, driverUser] = await Promise.all([
		createRoleUser("admin"),
		createRoleUser("operator"),
		createRoleUser("driver"),
	]);

	async function teardown(): Promise<void>
	{
		await Promise.all(
			[adminUser.id, operatorUser.id, driverUser.id].map((id) => admin.auth.admin.deleteUser(id)),
		);
		await admin.from("tenants").delete().eq("id", tenantId);
	}

	return {
		tenantId,
		admin: adminUser.client,
		operator: operatorUser.client,
		driver: driverUser.client,
		adminId: adminUser.id,
		operatorId: operatorUser.id,
		driverId: driverUser.id,
		teardown,
	};
}
