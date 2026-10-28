import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { mustChangePassword } from "@/lib/auth/password";

/**
 * The signed-in user, or null if there's none OR they still have to replace
 * an admin-generated password. Every Server Action should start here: the
 * proxy only redirects page loads, while a Server Action can be POSTed from
 * the one page a pending user may open (/account/password).
 */
export async function getActiveUser(supabase: SupabaseClient<Database>): Promise<User | null>
{
	const { data: { user } } = await supabase.auth.getUser();
	return user && !mustChangePassword(user) ? user : null;
}
