import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * service_role client — bypasses RLS entirely. Never import this in
 * client-facing code; only server scripts and privileged backend routes
 * (per CLAUDE.md §7: service_role stays in the backend, never the browser).
 */
export function createAdminClient()
{
	return createSupabaseClient<Database>(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.SUPABASE_SERVICE_ROLE_KEY!,
		{
			auth: {
				autoRefreshToken: false,
				persistSession: false,
			},
		},
	);
}
