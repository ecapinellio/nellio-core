import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { isBanned } from "@/lib/users/ban";

type Client = SupabaseClient<Database>;

export interface TenantUser
{
	id: string;
	name: string;
	role: string;
	email: string;
	createdAt: string;
	active: boolean;
}

const ROLE_ORDER: Record<string, number> = { admin: 0, operator: 1, driver: 2 };

/**
 * Active users first (admins at the top), deactivated last; by name within
 * each group (design review D3) — the owner scans for a person, and
 * deactivated accounts are history, not the working set.
 */
export function sortTenantUsers(users: TenantUser[]): TenantUser[]
{
	return [...users].sort((a, b) =>
		Number(b.active) - Number(a.active)
		|| (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
		|| a.name.localeCompare(b.name, "es"));
}

/**
 * Calls list_tenant_users() with the admin's OWN session (not service_role):
 * the RPC itself enforces admin-only + own tenant, so the page never needs
 * the service_role key just to render the list.
 */
export async function listTenantUsers(supabase: Client): Promise<{ data: TenantUser[] | null; error: { message: string } | null }>
{
	const { data, error } = await supabase.rpc("list_tenant_users");
	if (error || !data)
	{
		return { data: null, error: { message: error?.message ?? "No data" } };
	}

	const now = new Date();
	return {
		data: sortTenantUsers(data.map((u) => ({
			id: u.id,
			name: u.name,
			role: u.role,
			email: u.email,
			createdAt: u.created_at,
			active: !isBanned(u.banned_until, now),
		}))),
		error: null,
	};
}
