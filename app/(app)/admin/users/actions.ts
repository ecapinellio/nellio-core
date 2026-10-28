"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createUserInTenant, generatePassword } from "@/lib/users/create-user";
import { BAN_FOREVER, UNBAN, isBanned } from "@/lib/users/ban";
import { mustChangePassword } from "@/lib/auth/password";

export type CreatableRole = "operator" | "driver";

/** What the one-time password dialog shows — never stored anywhere. */
export interface Credentials
{
	name: string;
	email: string;
	role: CreatableRole;
	password: string;
}

export interface ActionResult<T>
{
	data: T | null;
	error: string | null;
}

export interface CreateOperatorOrDriverInput
{
	name: string;
	email: string;
	role: string;
}

const UNAUTHORIZED = "No autorizado.";

// Design review Decision 10 (slice 2): this is the ONLY message any failed
// creation ever shows — Supabase Auth emails are global, so echoing the real
// reason (e.g. "email already registered") would let an admin in one tenant
// probe whether an email exists in another. createUserInTenant()'s own error
// is specific (useful to the CLI script, which has a trusted operator
// reading it); this Server Action is the browser-facing boundary where it
// gets collapsed to one fixed string.
const GENERIC_CREATE_ERROR = "No se pudo crear el usuario. Intenta de nuevo.";

const USERS_PATH = "/admin/users";

function isCreatableRole(value: unknown): value is CreatableRole
{
	return value === "operator" || value === "driver";
}

interface AdminCaller
{
	userId: string;
	tenantId: string;
}

/**
 * Explicit server-side check (ADR-006) — this IS the backend boundary. Every
 * action below goes on to use the service_role client, which bypasses RLS
 * entirely, so nothing else stops a non-admin from calling them directly.
 *
 * tenantId comes from the caller's JWT, never from input (CLAUDE.md §6).
 */
async function requireAdmin(): Promise<AdminCaller | null>
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// A caller still on an admin-generated password must set their own
	// first — the proxy redirects them, this is the backend half (ADR-006).
	if (!user || user.app_metadata.role !== "admin" || mustChangePassword(user))
	{
		return null;
	}

	const tenantId: string | undefined = user.app_metadata.tenant_id;
	if (!tenantId)
	{
		return null;
	}

	return { userId: user.id, tenantId };
}

interface Target
{
	id: string;
	name: string;
	email: string;
	role: CreatableRole;
	banned: boolean;
}

/**
 * Resolves the user an action points at, or null if the caller may not
 * touch them (eng-review Decision 5). One null for every reason — not in
 * this tenant, doesn't exist, an admin, the caller themself — so the
 * response never reveals whether an id exists elsewhere.
 *
 * Checks both public.users AND the auth user's app_metadata: RLS and every
 * other check trust the JWT claims, so a row/claim mismatch (manual fix,
 * half-failed creation) must never let an admin pass as "operator" here.
 */
async function loadTarget(
	admin: ReturnType<typeof createAdminClient>,
	caller: AdminCaller,
	targetId: string,
): Promise<Target | null>
{
	if (typeof targetId !== "string" || targetId === caller.userId)
	{
		return null;
	}

	const { data: row, error } = await admin
		.from("users")
		.select("id, name, role")
		.eq("id", targetId)
		.eq("tenant_id", caller.tenantId)
		.maybeSingle();

	// A non-uuid id errors out at Postgres — same answer as "not found".
	if (error || !row || !isCreatableRole(row.role))
	{
		return null;
	}

	const { data: auth } = await admin.auth.admin.getUserById(targetId);
	const claims = auth.user?.app_metadata;
	if (!auth.user || claims?.tenant_id !== caller.tenantId || !isCreatableRole(claims?.role))
	{
		return null;
	}

	return {
		id: row.id,
		name: row.name,
		email: auth.user.email ?? "",
		role: row.role,
		banned: isBanned(auth.user.banned_until),
	};
}

export async function createOperatorOrDriver(
	input: CreateOperatorOrDriverInput,
): Promise<ActionResult<Credentials>>
{
	const caller = await requireAdmin();
	if (!caller)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const name = input.name.trim();
	const email = input.email.trim();

	if (!name || !email)
	{
		return { data: null, error: "Completa nombre y correo." };
	}

	// Self-service admin creation is explicitly out of scope (slice 2
	// eng-review Decision 6) — reject here even if a future UI bug ever lets
	// "admin" reach this far.
	if (!isCreatableRole(input.role))
	{
		return { data: null, error: "Rol inválido." };
	}

	const { data: created, error } = await createUserInTenant(createAdminClient(), {
		tenantId: caller.tenantId,
		email,
		name,
		role: input.role,
		createdBy: caller.userId,
	});

	if (error || !created)
	{
		return { data: null, error: GENERIC_CREATE_ERROR };
	}

	revalidatePath(USERS_PATH);
	return { data: { name, email: created.email, role: input.role, password: created.password }, error: null };
}

/**
 * New password, shown once. Changing it also deletes the user's sessions
 * (verified against GoTrue), and tenant_id() then rejects the old access
 * token too — so a reset signs them out everywhere, immediately.
 */
export async function resetUserPassword(userId: string): Promise<ActionResult<Credentials>>
{
	const caller = await requireAdmin();
	if (!caller)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const admin = createAdminClient();
	const target = await loadTarget(admin, caller, userId);
	if (!target)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	// Deactivated users get a new password through "Reactivar" instead —
	// resetting alone would leave them banned with a password nobody can use.
	if (target.banned)
	{
		return { data: null, error: "Este usuario está desactivado. Reactívalo para darle una contraseña nueva." };
	}

	const password = generatePassword();
	const { error } = await admin.auth.admin.updateUserById(target.id, { password, app_metadata: { must_change_password: true } });
	if (error)
	{
		return { data: null, error: "No se pudo restablecer la contraseña. Intenta de nuevo." };
	}

	revalidatePath(USERS_PATH);
	return { data: { name: target.name, email: target.email, role: target.role, password }, error: null };
}

/**
 * Ban only — no password change. While banned the user's sessions are
 * frozen (getUser() and refresh both fail, tenant_id() returns NULL), and
 * reactivation rotates the password, which is what actually kills them.
 */
export async function deactivateUser(userId: string): Promise<ActionResult<null>>
{
	const caller = await requireAdmin();
	if (!caller)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const admin = createAdminClient();
	const target = await loadTarget(admin, caller, userId);
	if (!target)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const { error } = await admin.auth.admin.updateUserById(target.id, { ban_duration: BAN_FOREVER });
	if (error)
	{
		return { data: null, error: "No se pudo desactivar. Intenta de nuevo." };
	}

	revalidatePath(USERS_PATH);
	return { data: null, error: null };
}

/**
 * Unban + new password in ONE call (eng-review Decision 2): an unban alone
 * would revive the refresh tokens frozen by the ban — e.g. on a lost phone.
 * Doing both atomically leaves no window where the old session works.
 */
export async function reactivateUser(userId: string): Promise<ActionResult<Credentials>>
{
	const caller = await requireAdmin();
	if (!caller)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const admin = createAdminClient();
	const target = await loadTarget(admin, caller, userId);
	if (!target)
	{
		return { data: null, error: UNAUTHORIZED };
	}

	const password = generatePassword();
	const { error } = await admin.auth.admin.updateUserById(target.id, {
		ban_duration: UNBAN,
		password,
		app_metadata: { must_change_password: true },
	});
	if (error)
	{
		return { data: null, error: "No se pudo reactivar. Intenta de nuevo." };
	}

	revalidatePath(USERS_PATH);
	return { data: { name: target.name, email: target.email, role: target.role, password }, error: null };
}
