"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createUserInTenant } from "@/lib/users/create-user";

export type CreatableRole = "operator" | "driver";

export interface CreateOperatorOrDriverInput
{
	name: string;
	email: string;
	role: string;
}

export interface CreateOperatorOrDriverResult
{
	data: { email: string; password: string; role: CreatableRole } | null;
	error: string | null;
}

// Design review Decision 10: this is the ONLY message any failed creation
// ever shows — Supabase Auth emails are global, so echoing the real reason
// (e.g. "email already registered") would let an admin in one tenant probe
// whether an email exists in another. createUserInTenant()'s own error is
// specific (useful to the CLI script, which has a trusted operator reading
// it); this Server Action is the browser-facing boundary where it gets
// collapsed to one fixed string.
const GENERIC_ERROR = "No se pudo crear el usuario. Intenta de nuevo.";

function isCreatableRole(value: string): value is CreatableRole
{
	return value === "operator" || value === "driver";
}

export async function createOperatorOrDriver(
	input: CreateOperatorOrDriverInput,
): Promise<CreateOperatorOrDriverResult>
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Explicit server-side check (ADR-006 / eng-review Decision 7) — this IS
	// the backend boundary. The admin client below bypasses RLS entirely, so
	// nothing else stops a non-admin from calling this action directly.
	if (!user || user.app_metadata.role !== "admin")
	{
		return { data: null, error: "No autorizado." };
	}

	// tenantId MUST come from the caller's JWT, never from input/formData —
	// this is the exact rule CLAUDE.md §6 exists to enforce, and the reason
	// this feature exists instead of operators editing the DB directly.
	const tenantId: string | undefined = user.app_metadata.tenant_id;
	if (!tenantId)
	{
		return { data: null, error: "No autorizado." };
	}

	const name = input.name.trim();
	const email = input.email.trim();

	if (!name || !email)
	{
		return { data: null, error: "Completa nombre y correo." };
	}

	// Design review Decision: self-service admin creation is explicitly out
	// of scope (eng-review Decision 6) — reject here even if a future UI
	// bug ever lets "admin" reach this far.
	if (!isCreatableRole(input.role))
	{
		return { data: null, error: "Rol inválido." };
	}

	const { data: created, error } = await createUserInTenant(createAdminClient(), {
		tenantId,
		email,
		name,
		role: input.role,
		createdBy: user.id,
	});

	if (error || !created)
	{
		return { data: null, error: GENERIC_ERROR };
	}

	return { data: { email: created.email, password: created.password, role: input.role }, error: null };
}
