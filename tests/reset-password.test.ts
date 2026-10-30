import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { setupTenant, type TestTenant } from "@/tests/fixtures";
import { createUserInTenant } from "@/lib/users/create-user";
import { BAN_FOREVER } from "@/lib/users/ban";
import { newPasswordError } from "@/lib/auth/password";
import { findAuthUserByEmail, resetPasswordForUser } from "@/lib/users/reset-password";

type Client = SupabaseClient<Database>;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const service: Client = createClient<Database>(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
	auth: { autoRefreshToken: false, persistSession: false },
});

async function signIn(email: string, password: string)
{
	const client = createClient<Database>(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const { error } = await client.auth.signInWithPassword({ email, password });
	return { client, error };
}

describe("findAuthUserByEmail() / resetPasswordForUser() — scripts/reset-password.ts", () =>
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

	async function makeUser()
	{
		const email = `reset+${randomUUID()}@test.nellio.local`;
		const { data } = await createUserInTenant(service, {
			tenantId: tenant.tenantId, email, name: "Reset me", role: "admin", createdBy: null, mustChangePassword: false, password: "Dueno-Original-2026!",
		});
		createdAuthIds.push(data!.id);
		return { id: data!.id, email, password: data!.password };
	}

	it("finds the user by email (any case), sets a compliant temporary password and forces a change", async () =>
	{
		const user = await makeUser();
		const session = await signIn(user.email, user.password);

		const found = await findAuthUserByEmail(service, `  ${user.email.toUpperCase()} `);
		expect(found!.id).toBe(user.id);
		const { data, error } = await resetPasswordForUser(service, found!);
		expect(error).toBeNull();
		expect(data).toMatchObject({ userId: user.id, role: "admin", tenantId: tenant.tenantId, banned: false });
		expect(newPasswordError(data!.password, data!.password)).toBeNull();

		const { data: auth } = await service.auth.admin.getUserById(user.id);
		expect(auth.user!.app_metadata).toMatchObject({ must_change_password: true, tenant_id: tenant.tenantId, role: "admin" });

		expect((await signIn(user.email, user.password)).error).not.toBeNull();
		expect((await signIn(user.email, data!.password)).error).toBeNull();
		// Old session is gone (ADR-009).
		expect((await session.client.from("users").select("id")).data).toEqual([]);
	});

	it("reports a deactivated user so the owner knows to reactivate them", async () =>
	{
		const user = await makeUser();
		await service.auth.admin.updateUserById(user.id, { ban_duration: BAN_FOREVER });
		const { data } = await resetPasswordForUser(service, (await findAuthUserByEmail(service, user.email))!);
		expect(data!.banned).toBe(true);
	});

	it("returns null for an unknown email, searching every page", async () =>
	{
		expect(await findAuthUserByEmail(service, `nadie+${randomUUID()}@test.nellio.local`)).toBeNull();
	});
});
