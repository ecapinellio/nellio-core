import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createUserInTenant } from "@/lib/users/create-user";
import { isBanned } from "@/lib/users/ban";
import { listTenantUsers, sortTenantUsers, type TenantUser } from "@/lib/users/list-users";
import type { Role } from "@/lib/rbac";

type Client = SupabaseClient<Database>;

// Same seam as create-user.test.ts: only the cookie plumbing is swapped —
// `caller` is a really-signed-in fixture client, so getUser() validates a
// real JWT against the local auth server.
let caller: Client;
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));

const { resetUserPassword, deactivateUser, reactivateUser } = await import("@/app/(app)/admin/users/actions");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const service: Client = createClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
	auth: { autoRefreshToken: false, persistSession: false },
});

function anonClient(): Client
{
	return createClient<Database>(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function signIn(email: string, password: string)
{
	const client = anonClient();
	const { data, error } = await client.auth.signInWithPassword({ email, password });
	return { client, session: data.session, error };
}

describe("user management: list, restore password, deactivate, reactivate", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	const createdAuthIds: string[] = [];

	beforeAll(async () =>
	{
		[tenant, otherTenant] = await Promise.all([setupTenant(), setupTenant()]);
	});

	afterAll(async () =>
	{
		await Promise.all(createdAuthIds.map((id) => service.auth.admin.deleteUser(id)));
		await Promise.all([tenant.teardown(), otherTenant.teardown()]);
	});

	beforeEach(() =>
	{
		caller = tenant.admin;
	});

	/** A fresh signed-in user per test, so killing its session can't leak into other tests. */
	async function makeUser(role: Role, inTenant: TestTenant = tenant)
	{
		const email = `managed+${randomUUID()}@test.nellio.local`;
		const { data, error } = await createUserInTenant(service, {
			tenantId: inTenant.tenantId, email, name: `Managed ${role}`, role, createdBy: null,
		});
		expect(error).toBeNull();
		createdAuthIds.push(data!.id);
		const { client, session } = await signIn(email, data!.password);
		return { id: data!.id, email, password: data!.password, client, session: session! };
	}

	describe("isBanned()", () =>
	{
		const now = new Date("2026-10-24T12:00:00Z");

		it("is false for null/empty, a past timestamp, and garbage", () =>
		{
			expect(isBanned(null, now)).toBe(false);
			expect(isBanned("", now)).toBe(false);
			expect(isBanned("2026-10-01T00:00:00Z", now)).toBe(false);
			expect(isBanned("not a date", now)).toBe(false);
		});

		it("is true for a future timestamp", () =>
		{
			expect(isBanned("2126-10-01T00:00:00Z", now)).toBe(true);
		});
	});

	describe("sortTenantUsers()", () =>
	{
		const u = (name: string, role: string, active: boolean): TenantUser =>
			({ id: name, name, role, active, email: "", createdAt: "" });

		it("puts active first, admins at the top, deactivated last, by name within groups", () =>
		{
			const sorted = sortTenantUsers([
				u("Zoe", "driver", true),
				u("Ana", "operator", false),
				u("Beto", "operator", true),
				u("Milo", "admin", true),
				u("Carla", "driver", true),
			]);
			expect(sorted.map((x) => x.name)).toEqual(["Milo", "Beto", "Carla", "Zoe", "Ana"]);
		});
	});

	describe("list_tenant_users() / listTenantUsers()", () =>
	{
		it("gives an admin their own tenant's users with email and status", async () =>
		{
			const { data, error } = await listTenantUsers(tenant.admin);
			expect(error).toBeNull();

			const ids = data!.map((x) => x.id);
			expect(ids).toEqual(expect.arrayContaining([tenant.adminId, tenant.operatorId, tenant.driverId]));
			expect(ids).not.toContain(otherTenant.adminId);

			const me = data!.find((x) => x.id === tenant.adminId)!;
			expect(me.email).toMatch(/@test\.nellio\.local$/);
			expect(me.active).toBe(true);
		});

		it.each(["operator", "driver"] as const)("rejects a %s", async (role) =>
		{
			const client = role === "operator" ? otherTenant.operator : otherTenant.driver;
			const { data, error } = await client.rpc("list_tenant_users");
			expect(data).toBeNull();
			expect(error?.message).toMatch(/Not authorized/);
		});
	});

	describe("authorization (requireAdmin + loadTarget)", () =>
	{
		it.each(["operator", "driver"] as const)("a %s caller can't run any action", async (role) =>
		{
			caller = role === "operator" ? otherTenant.operator : otherTenant.driver;
			const target = otherTenant.driverId;
			for (const action of [resetUserPassword, deactivateUser, reactivateUser])
			{
				expect(await action(target)).toEqual({ data: null, error: "No autorizado." });
			}
		});

		it("rejects a user from another tenant, an admin, oneself, an unknown id and a non-uuid", async () =>
		{
			const foreign = await makeUser("driver", otherTenant);
			for (const id of [foreign.id, tenant.adminId, randomUUID(), "not-a-uuid"])
			{
				for (const action of [resetUserPassword, deactivateUser, reactivateUser])
				{
					expect(await action(id)).toEqual({ data: null, error: "No autorizado." });
				}
			}

			// The foreign user was left untouched.
			const { error } = await signIn(foreign.email, foreign.password);
			expect(error).toBeNull();
		});

		it("rejects a target whose JWT role is admin even if the users row says operator", async () =>
		{
			const mismatched = await makeUser("admin");
			await service.from("users").update({ role: "operator" }).eq("id", mismatched.id);

			expect(await deactivateUser(mismatched.id)).toEqual({ data: null, error: "No autorizado." });
		});
	});

	describe("resetUserPassword()", () =>
	{
		it("returns a new password that works and kills the old session", async () =>
		{
			const user = await makeUser("operator");
			expect((await user.client.from("customers").select("id")).error).toBeNull();

			const result = await resetUserPassword(user.id);
			expect(result.error).toBeNull();
			expect(result.data).toMatchObject({ name: "Managed operator", email: user.email, role: "operator" });
			expect(result.data!.password).not.toBe(user.password);

			// Old access token: tenant_id() sees the session row is gone.
			expect((await user.client.from("users").select("id")).data).toEqual([]);
			expect((await anonClient().auth.refreshSession({ refresh_token: user.session.refresh_token })).error).not.toBeNull();

			expect((await signIn(user.email, user.password)).error).not.toBeNull();
			expect((await signIn(user.email, result.data!.password)).error).toBeNull();
		});

		it("refuses a deactivated user (reactivate gives them a password instead)", async () =>
		{
			const user = await makeUser("driver");
			await deactivateUser(user.id);

			const result = await resetUserPassword(user.id);
			expect(result.data).toBeNull();
			expect(result.error).toMatch(/desactivado/);
		});
	});

	describe("deactivateUser() / reactivateUser()", () =>
	{
		it("deactivate blocks login and data access, and the list shows it", async () =>
		{
			const user = await makeUser("driver");

			expect(await deactivateUser(user.id)).toEqual({ data: null, error: null });

			expect((await signIn(user.email, user.password)).error?.message).toMatch(/banned/i);
			expect((await user.client.from("users").select("id")).data).toEqual([]);

			const { data } = await listTenantUsers(tenant.admin);
			expect(data!.find((x) => x.id === user.id)!.active).toBe(false);
		});

		it("reactivate gives a working new password and does NOT revive the old session", async () =>
		{
			const user = await makeUser("operator");
			await deactivateUser(user.id);

			const result = await reactivateUser(user.id);
			expect(result.error).toBeNull();
			expect(result.data).toMatchObject({ email: user.email, role: "operator" });

			// The frozen refresh token would work again after a plain unban.
			expect((await anonClient().auth.refreshSession({ refresh_token: user.session.refresh_token })).error).not.toBeNull();
			expect((await user.client.from("users").select("id")).data).toEqual([]);

			const fresh = await signIn(user.email, result.data!.password);
			expect(fresh.error).toBeNull();
			expect((await fresh.client.from("users").select("id")).data!.length).toBeGreaterThan(0);

			const { data } = await listTenantUsers(tenant.admin);
			expect(data!.find((x) => x.id === user.id)!.active).toBe(true);
		});
	});
});
