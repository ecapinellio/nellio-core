import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Role } from "@/lib/rbac";

type Client = SupabaseClient<Database>;

export interface CreateUserInTenantInput
{
	tenantId: string;
	email: string;
	name: string;
	role: Role;
	/**
	 * The admin who initiated this creation, or null for the bootstrap
	 * script's first admin of a tenant (no calling admin exists yet).
	 * Stamped onto users.created_by.
	 */
	createdBy: string | null;
	/** CLI override (scripts/create-first-user.ts --admin-password); omit to auto-generate. */
	password?: string;
}

export interface CreateUserInTenantResult
{
	id: string;
	email: string;
	name: string;
	role: Role;
	password: string;
}

export interface CreateUserInTenantError
{
	message: string;
}

export function generatePassword(): string
{
	return randomBytes(18).toString("base64url");
}

/**
 * Shared by scripts/create-first-user.ts (CLI, tenantId is an
 * operator-trusted arg) and the admin-users Server Action (tenantId MUST
 * come from the calling admin's JWT, never form input — enforced at that
 * call site, not here, since this helper has no way to know which caller
 * it's talking to).
 *
 * Takes the service_role client as a parameter rather than constructing
 * one internally — same reason as lib/supabase/queries.ts's helpers: the
 * CLI script and the Server Action build their admin client differently
 * (the script can't import lib/supabase/admin.ts — it's marked
 * "server-only", which throws outside Next's own bundler, including
 * under tsx).
 *
 * The error message returned here is intentionally specific (e.g. raw
 * "email already registered") — this helper has no browser-facing
 * consumer. The Server Action caller maps any error to one fixed generic
 * message before it reaches the UI (eng-review Decision 10's anti-
 * enumeration requirement is a presentation-layer rule, not a data-layer
 * one); the CLI script prints this message directly since the operator
 * running it benefits from knowing why it failed.
 */
export async function createUserInTenant(
	admin: Client,
	input: CreateUserInTenantInput,
): Promise<{ data: CreateUserInTenantResult | null; error: CreateUserInTenantError | null }>
{
	const password = input.password ?? generatePassword();

	// Created banned and only unbanned once the users row exists: the JWT
	// already carries tenant_id + role, and RLS trusts those claims, so an
	// auth user left behind by a crash or a failed rollback below must not
	// be able to sign in. ~100 years — GoTrue's duration format has no
	// "forever"; the unban below lifts it with "none".
	const { data: authUser, error: authError } = await admin.auth.admin.createUser({
		email: input.email,
		password,
		email_confirm: true,
		ban_duration: "876000h",
		app_metadata: {
			tenant_id: input.tenantId,
			role: input.role,
		},
	});

	if (authError || !authUser.user)
	{
		return { data: null, error: { message: authError?.message ?? "Failed to create auth user" } };
	}

	const { error: insertError } = await admin.from("users").insert({
		id: authUser.user.id,
		tenant_id: input.tenantId,
		name: input.name,
		role: input.role,
		created_by: input.createdBy,
	});

	const { error: unbanError } = insertError
		? { error: null }
		: await admin.auth.admin.updateUserById(authUser.user.id, { ban_duration: "none" });

	const failure = insertError ?? unbanError;
	if (failure)
	{
		// Compensating rollback (eng-review Decision 5): free the email for
		// retry (deleting the auth user cascades the users row too, if the
		// insert got that far). If the delete itself fails, the orphan stays
		// banned — it can't sign in, only blocks the email — and is logged
		// loudly since nothing else will catch it.
		const { error: deleteError } = await admin.auth.admin.deleteUser(authUser.user.id);
		if (deleteError)
		{
			console.error(
				`createUserInTenant: rollback failed — orphaned (banned) auth user ${authUser.user.id} (${input.email}). Error: ${failure.message}. Delete error: ${deleteError.message}`,
			);
		}
		return { data: null, error: { message: failure.message } };
	}

	return {
		data: { id: authUser.user.id, email: input.email, name: input.name, role: input.role, password },
		error: null,
	};
}
