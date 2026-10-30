import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { generatePassword } from "@/lib/users/create-user";
import { isBanned } from "@/lib/users/ban";

type Client = SupabaseClient<Database>;

export interface ResetPasswordResult
{
	userId: string;
	email: string;
	role: string | null;
	tenantId: string | null;
	password: string;
	/** Deactivated users still can't sign in — reactivate them in /admin/users. */
	banned: boolean;
}

/** Auth's admin API has no lookup by email; page through users (small tenants). */
export async function findAuthUserByEmail(admin: Client, email: string): Promise<User | null>
{
	const target = email.trim().toLowerCase();
	for (let page = 1; ; page++)
	{
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
		if (error)
		{
			throw new Error(`Failed to list users: ${error.message}`);
		}
		const match = data.users.find((u) => u.email?.toLowerCase() === target);
		if (match || data.users.length < 200)
		{
			return match ?? null;
		}
	}
}

/**
 * Platform-owner recovery (scripts/reset-password.ts): new generated
 * password, shown once, and the person must replace it on next login —
 * same rules as an admin restoring it in /admin/users. Changing the
 * password also ends every session the user had (verified, ADR-009).
 * Takes the service_role client; never call this from browser-facing code.
 */
export async function resetPasswordByEmail(
	admin: Client,
	email: string,
): Promise<{ data: ResetPasswordResult | null; error: string | null }>
{
	const user = await findAuthUserByEmail(admin, email);
	if (!user)
	{
		return { data: null, error: `No user with email ${email}` };
	}

	const password = generatePassword();
	const { error } = await admin.auth.admin.updateUserById(user.id, {
		password,
		app_metadata: { must_change_password: true },
	});
	if (error)
	{
		return { data: null, error: `Failed to reset password: ${error.message}` };
	}

	return {
		data: {
			userId: user.id,
			email: user.email ?? email,
			role: (user.app_metadata.role as string | undefined) ?? null,
			tenantId: (user.app_metadata.tenant_id as string | undefined) ?? null,
			password,
			banned: isBanned(user.banned_until),
		},
		error: null,
	};
}
