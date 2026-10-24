import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createUserInTenant } from "@/lib/users/create-user";

type Client = SupabaseClient<Database>;

// The Server Action reads the caller from next/headers cookies, which don't
// exist outside a request. Only that plumbing is swapped: the client handed
// back is one of the fixture's really-signed-in clients, so getUser() still
// validates a real JWT against the local auth server.
let caller: Client;
vi.mock("server-only", () => ({}));
// revalidatePath needs a Next request context; the list refresh is UI-only.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));

const { createOperatorOrDriver } = await import("@/app/(app)/admin/users/actions");

const service: Client = createClient<Database>(
	process.env.NEXT_PUBLIC_SUPABASE_URL!,
	process.env.SUPABASE_SERVICE_ROLE_KEY!,
	{ auth: { autoRefreshToken: false, persistSession: false } },
);

describe("createUserInTenant() / createOperatorOrDriver()", () =>
{
	let tenant: TestTenant;
	let otherTenant: TestTenant;
	// fixture teardown only deletes its own three auth users; everything
	// created here has to be cleaned up explicitly (auth.users has no FK
	// to tenants, so the tenant cascade never reaches it).
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

	function freshEmail(): string
	{
		return `created+${randomUUID()}@test.nellio.local`;
	}

	async function findAuthIdByEmail(email: string): Promise<string | null>
	{
		const { data: list } = await service.auth.admin.listUsers({ perPage: 1000 });
		return list.users.find((u) => u.email === email)?.id ?? null;
	}

	describe("createUserInTenant()", () =>
	{
		it("creates the auth user and users row, stamping created_by and app_metadata", async () =>
		{
			const email = freshEmail();
			const { data, error } = await createUserInTenant(service, {
				tenantId: tenant.tenantId,
				email,
				name: "Helper Operator",
				role: "operator",
				createdBy: tenant.adminId,
			});

			expect(error).toBeNull();
			createdAuthIds.push(data!.id);
			expect(data!.password.length).toBeGreaterThanOrEqual(24);

			const { data: row } = await service.from("users").select().eq("id", data!.id).single();
			expect(row).toMatchObject({ tenant_id: tenant.tenantId, name: "Helper Operator", role: "operator", created_by: tenant.adminId });

			const { data: authUser } = await service.auth.admin.getUserById(data!.id);
			expect(authUser.user!.app_metadata).toMatchObject({ tenant_id: tenant.tenantId, role: "operator" });
		});

		it("returns an error and creates nothing when the email is already registered", async () =>
		{
			const email = freshEmail();
			const first = await createUserInTenant(service, {
				tenantId: tenant.tenantId, email, name: "First", role: "driver", createdBy: null,
			});
			createdAuthIds.push(first.data!.id);

			const second = await createUserInTenant(service, {
				tenantId: tenant.tenantId, email, name: "Second", role: "driver", createdBy: null,
			});

			expect(second.data).toBeNull();
			expect(second.error).not.toBeNull();

			const { count } = await service.from("users").select("id", { count: "exact", head: true }).eq("name", "Second").eq("tenant_id", tenant.tenantId);
			expect(count).toBe(0);
		});

		it("rolls back the auth user when the users insert fails, freeing the email", async () =>
		{
			const email = freshEmail();
			// Nonexistent tenant → users.tenant_id FK violation after the
			// auth user already exists.
			const failed = await createUserInTenant(service, {
				tenantId: randomUUID(), email, name: "Orphan", role: "operator", createdBy: null,
			});

			expect(failed.data).toBeNull();
			expect(failed.error).not.toBeNull();
			expect(await findAuthIdByEmail(email)).toBeNull();

			// The email is reusable — proof the compensating delete ran.
			const retry = await createUserInTenant(service, {
				tenantId: tenant.tenantId, email, name: "Retry", role: "operator", createdBy: null,
			});
			expect(retry.error).toBeNull();
			createdAuthIds.push(retry.data!.id);
		});
	});

	describe("createOperatorOrDriver() Server Action", () =>
	{
		it("lets an admin create an operator in their own tenant and returns the password once", async () =>
		{
			const email = freshEmail();
			const result = await createOperatorOrDriver({ name: "  Alejandra  ", email: `  ${email}  `, role: "operator" });

			expect(result.error).toBeNull();
			expect(result.data).toMatchObject({ email, role: "operator" });
			expect(result.data!.password).toBeTruthy();

			const authId = await findAuthIdByEmail(email);
			createdAuthIds.push(authId!);
			const { data: row } = await service.from("users").select().eq("id", authId!).single();
			expect(row).toMatchObject({ tenant_id: tenant.tenantId, name: "Alejandra", role: "operator", created_by: tenant.adminId });
		});

		it("takes tenantId from the caller's JWT, ignoring any tenantId smuggled into the input", async () =>
		{
			const email = freshEmail();
			const result = await createOperatorOrDriver({
				name: "Smuggled", email, role: "driver", tenantId: otherTenant.tenantId,
			} as Parameters<typeof createOperatorOrDriver>[0]);

			expect(result.error).toBeNull();
			const authId = await findAuthIdByEmail(email);
			createdAuthIds.push(authId!);
			const { data: row } = await service.from("users").select("tenant_id").eq("id", authId!).single();
			expect(row!.tenant_id).toBe(tenant.tenantId);
		});

		it("the created user can sign in with the returned password", async () =>
		{
			const email = freshEmail();
			const result = await createOperatorOrDriver({ name: "Login Check", email, role: "driver" });
			createdAuthIds.push((await findAuthIdByEmail(email))!);

			const client = createClient<Database>(
				process.env.NEXT_PUBLIC_SUPABASE_URL!,
				process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
				{ auth: { autoRefreshToken: false, persistSession: false } },
			);
			const { data, error } = await client.auth.signInWithPassword({ email, password: result.data!.password });
			expect(error).toBeNull();
			expect(data.user!.app_metadata).toMatchObject({ tenant_id: tenant.tenantId, role: "driver" });
		});

		it.each(["operator", "driver"] as const)("rejects a %s caller before creating anything", async (role) =>
		{
			caller = role === "operator" ? tenant.operator : tenant.driver;
			const email = freshEmail();
			const result = await createOperatorOrDriver({ name: "Nope", email, role: "operator" });

			expect(result).toEqual({ data: null, error: "No autorizado." });
			expect(await findAuthIdByEmail(email)).toBeNull();
		});

		it("rejects role=admin even from an admin caller", async () =>
		{
			const email = freshEmail();
			const result = await createOperatorOrDriver({ name: "Wannabe Admin", email, role: "admin" });

			expect(result).toEqual({ data: null, error: "Rol inválido." });
			expect(await findAuthIdByEmail(email)).toBeNull();
		});

		it("rejects blank name or email", async () =>
		{
			expect((await createOperatorOrDriver({ name: "   ", email: freshEmail(), role: "driver" })).error).toBe("Completa nombre y correo.");
			expect((await createOperatorOrDriver({ name: "Someone", email: "  ", role: "driver" })).error).toBe("Completa nombre y correo.");
		});

		it("maps a duplicate email (even one from another tenant) to the generic message", async () =>
		{
			// The email lives in otherTenant — the raw Supabase error would
			// leak that it exists somewhere (Decision 10).
			const email = freshEmail();
			const existing = await createUserInTenant(service, {
				tenantId: otherTenant.tenantId, email, name: "Elsewhere", role: "operator", createdBy: null,
			});
			createdAuthIds.push(existing.data!.id);

			const result = await createOperatorOrDriver({ name: "Collision", email, role: "operator" });
			expect(result).toEqual({ data: null, error: "No se pudo crear el usuario. Intenta de nuevo." });
		});
	});
});
