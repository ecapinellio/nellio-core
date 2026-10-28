import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createUserInTenant } from "@/lib/users/create-user";
import { mustChangePassword, newPasswordError } from "@/lib/auth/password";
import { isRouteAllowed, type Role } from "@/lib/rbac";

type Client = SupabaseClient<Database>;

// Same seam as the other Server Action tests; redirect() throws so the
// test can see where the action sent the user.
let caller: Client;
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => caller }));
vi.mock("next/navigation", () => ({
	redirect: (url: string) =>
	{
		throw new Error(`REDIRECT ${url}`);
	},
}));

const { changePassword } = await import("@/lib/auth/actions");
const { resetUserPassword, reactivateUser, deactivateUser } = await import("@/app/(app)/admin/users/actions");
const { saveProducts } = await import("@/app/(app)/products/actions");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const service: Client = createClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
	auth: { autoRefreshToken: false, persistSession: false },
});

async function signIn(email: string, password: string)
{
	const client = createClient<Database>(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
	const { error } = await client.auth.signInWithPassword({ email, password });
	return { client, error };
}

function form(password: string, confirm = password): FormData
{
	const data = new FormData();
	data.set("password", password);
	data.set("confirm", confirm);
	return data;
}

async function appMetadata(id: string)
{
	const { data } = await service.auth.admin.getUserById(id);
	return data.user!.app_metadata;
}

describe("must_change_password: forced first-login password change", () =>
{
	let tenant: TestTenant;
	const createdAuthIds: string[] = [];

	beforeAll(async () =>
	{
		tenant = await setupTenant();
	});

	afterAll(async () =>
	{
		await Promise.all(createdAuthIds.map((id) => service.auth.admin.deleteUser(id)));
		await tenant.teardown();
	});

	beforeEach(() =>
	{
		caller = tenant.admin;
	});

	async function makeUser(role: Role, password?: string)
	{
		const email = `pw+${randomUUID()}@test.nellio.local`;
		const { data, error } = await createUserInTenant(service, {
			tenantId: tenant.tenantId, email, name: `Pw ${role}`, role, createdBy: null, password,
		});
		expect(error).toBeNull();
		createdAuthIds.push(data!.id);
		const { client } = await signIn(email, data!.password);
		return { id: data!.id, email, password: data!.password, client };
	}

	describe("newPasswordError() / mustChangePassword()", () =>
	{
		it("validates length, byte limit and confirmation", () =>
		{
			expect(newPasswordError("", "")).toBe("Escribe tu contraseña nueva.");
			expect(newPasswordError("corta", "corta")).toBe("Usa al menos 10 caracteres.");
			expect(newPasswordError("ñ".repeat(40), "ñ".repeat(40))).toBe("Usa como máximo 72 caracteres.");
			expect(newPasswordError("una frase larga", "otra frase")).toBe("Las dos contraseñas no coinciden.");
			expect(newPasswordError("una frase larga", "una frase larga")).toBeNull();
		});

		it("reads only a strict true flag", () =>
		{
			expect(mustChangePassword({ app_metadata: { must_change_password: true } })).toBe(true);
			expect(mustChangePassword({ app_metadata: { must_change_password: "true" } })).toBe(false);
			expect(mustChangePassword({ app_metadata: {} })).toBe(false);
			expect(mustChangePassword(null)).toBe(false);
		});
	});

	describe("who gets the flag", () =>
	{
		it("a generated password sets it; one chosen by the owner (bootstrap) doesn't", async () =>
		{
			const generated = await makeUser("operator");
			const chosen = await makeUser("admin", "dueño-elige-su-clave");
			expect(await appMetadata(generated.id)).toMatchObject({ must_change_password: true, tenant_id: tenant.tenantId, role: "operator" });
			expect(await appMetadata(chosen.id)).toMatchObject({ must_change_password: false });
		});

		it("restore and reactivate set it again, keeping tenant and role", async () =>
		{
			const user = await makeUser("driver");
			await service.auth.admin.updateUserById(user.id, { app_metadata: { must_change_password: false } });

			expect((await resetUserPassword(user.id)).error).toBeNull();
			expect(await appMetadata(user.id)).toMatchObject({ must_change_password: true, tenant_id: tenant.tenantId, role: "driver" });

			await service.auth.admin.updateUserById(user.id, { app_metadata: { must_change_password: false } });
			await deactivateUser(user.id);
			expect((await reactivateUser(user.id)).error).toBeNull();
			expect(await appMetadata(user.id)).toMatchObject({ must_change_password: true, tenant_id: tenant.tenantId, role: "driver" });
		});
	});

	describe("changePassword() Server Action", () =>
	{
		it("forced: sets the new password, clears the flag (tenant/role intact) and sends the user home", async () =>
		{
			const user = await makeUser("operator");
			caller = user.client;

			await expect(changePassword({ error: null }, form("mi frase secreta"))).rejects.toThrow("REDIRECT /");

			expect(await appMetadata(user.id)).toMatchObject({ must_change_password: false, tenant_id: tenant.tenantId, role: "operator" });
			expect((await signIn(user.email, user.password)).error).not.toBeNull();
			expect((await signIn(user.email, "mi frase secreta")).error).toBeNull();
		});

		it("voluntary: changes the password and stays on the page with a confirmation", async () =>
		{
			const user = await makeUser("driver", "clave-elegida-1");
			caller = user.client;
			await expect(changePassword({ error: null }, form("clave-elegida-2"))).rejects.toThrow("REDIRECT /account/password?changed=1");
			expect((await signIn(user.email, "clave-elegida-2")).error).toBeNull();
		});

		it("returns readable errors and changes nothing", async () =>
		{
			const user = await makeUser("operator");
			caller = user.client;
			expect(await changePassword({ error: null }, form("corta"))).toEqual({ error: "Usa al menos 10 caracteres." });
			expect(await changePassword({ error: null }, form("una frase larga", "distinta"))).toEqual({ error: "Las dos contraseñas no coinciden." });
			expect(await changePassword({ error: null }, form(user.password))).toEqual({ error: "La contraseña nueva tiene que ser distinta a la actual." });
			expect(await appMetadata(user.id)).toMatchObject({ must_change_password: true });
		});
	});

	describe("backend half of the block (ADR-006)", () =>
	{
		it("server actions reject a caller who still has to change their password", async () =>
		{
			const admin = await makeUser("admin");
			const operator = await makeUser("operator");

			caller = admin.client;
			expect(await resetUserPassword(operator.id)).toEqual({ data: null, error: "No autorizado." });

			caller = operator.client;
			expect(await saveProducts([{ id: null, name: `Bloqueado ${randomUUID()}`, price_per_unit: 1, unit: "kg", active: true, updated_at: null }]))
				.toEqual({ status: "error", error: "No autorizado." });
		});
	});

	it("/account is open to every role", () =>
	{
		for (const role of ["admin", "operator", "driver"] as const)
		{
			expect(isRouteAllowed("/account/password", role)).toBe(true);
		}
	});
});
