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

function form(password: string, confirm = password, current?: string): FormData
{
	const data = new FormData();
	data.set("password", password);
	data.set("confirm", confirm);
	if (current !== undefined)
	{
		data.set("current", current);
	}
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

	async function makeUser(role: Role, password?: string, mustChangePassword?: boolean)
	{
		const email = `pw+${randomUUID()}@test.nellio.local`;
		const { data, error } = await createUserInTenant(service, {
			tenantId: tenant.tenantId, email, name: `Pw ${role}`, role, createdBy: null, password, mustChangePassword,
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
		it("set for generated passwords and passwords typed on someone's behalf; off only on request (--keep-password)", async () =>
		{
			const generated = await makeUser("operator");
			const typedForThem = await makeUser("admin", "alguien-la-escribio");
			const ownerChose = await makeUser("admin", "dueño-elige-su-clave", false);
			expect(await appMetadata(generated.id)).toMatchObject({ must_change_password: true, tenant_id: tenant.tenantId, role: "operator" });
			expect(await appMetadata(typedForThem.id)).toMatchObject({ must_change_password: true });
			expect(await appMetadata(ownerChose.id)).toMatchObject({ must_change_password: false });
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

		it("closes every other session — e.g. the admin who signed in with the temporary password", async () =>
		{
			const user = await makeUser("operator");
			const elsewhere = await signIn(user.email, user.password);
			const { data: before } = await elsewhere.client.from("users").select("id");
			expect(before!.length).toBeGreaterThan(0);
			const { data: { session } } = await elsewhere.client.auth.getSession();

			caller = user.client;
			await expect(changePassword({ error: null }, form("solo yo la conozco"))).rejects.toThrow("REDIRECT /");

			expect((await elsewhere.client.from("users").select("id")).data).toEqual([]);
			expect((await elsewhere.client.auth.refreshSession({ refresh_token: session!.refresh_token })).error).not.toBeNull();
			// The session that made the change keeps working.
			expect((await user.client.from("users").select("id")).data!.length).toBeGreaterThan(0);
		});

		it("voluntary: requires the current password, then changes it and confirms", async () =>
		{
			const user = await makeUser("driver", "clave-elegida-1", false);
			caller = user.client;
			expect(await changePassword({ error: null }, form("clave-elegida-2"))).toEqual({ error: "Escribe tu contraseña actual." });
			expect(await changePassword({ error: null }, form("clave-elegida-2", "clave-elegida-2", "no-es-esta"))).toEqual({ error: "La contraseña actual no es correcta." });
			expect((await signIn(user.email, "clave-elegida-1")).error).toBeNull();

			await expect(changePassword({ error: null }, form("clave-elegida-2", "clave-elegida-2", "clave-elegida-1"))).rejects.toThrow("REDIRECT /account/password?changed=1");
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
