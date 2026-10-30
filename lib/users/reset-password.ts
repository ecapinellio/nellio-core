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

/**
 * Auth's admin API has no lookup by email, so this pages through every
 * user (following nextPage, not a page-size guess). More than one match —
 * possible once SSO is on — is an error, never "the first one".
 */
export async function findAuthUserByEmail(admin: Client, email: string): Promise<User | null>
{
	const target = email.trim().toLowerCase();
	const matches: User[] = [];
	for (let page: number | null = 1; page !== null;)
	{
		const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
		if (error)
		{
			throw new Error(`Failed to list users: ${error.message}`);
		}
		matches.push(...data.users.filter((u) => u.email?.toLowerCase() === target));
		page = data.nextPage;
	}
	if (matches.length > 1)
	{
		throw new Error(`${matches.length} users share the email ${email} — resolve it in the Supabase dashboard`);
	}
	return matches[0] ?? null;
}

/**
 * Platform-owner recovery (scripts/reset-password.ts): new generated
 * password, shown once, and the person must replace it on next login —
 * same rules as an admin restoring it in /admin/users. Changing the
 * password also ends every session the user had (verified, ADR-009).
 * Takes the user already looked up (and confirmed by the operator), so the
 * account that changes is exactly the one that was shown.
 * service_role client only; never call this from browser-facing code.
 */
export async function resetPasswordForUser(
	admin: Client,
	user: User,
): Promise<{ data: ResetPasswordResult | null; error: string | null }>
{
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
			email: user.email ?? "",
			role: (user.app_metadata.role as string | undefined) ?? null,
			tenantId: (user.app_metadata.tenant_id as string | undefined) ?? null,
			password,
			banned: isBanned(user.banned_until),
		},
		error: null,
	};
}
