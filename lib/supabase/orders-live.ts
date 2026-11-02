import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Calls `onChange` when an order of the tenant or one of its lines changes.
 * Realtime checks the subscriber's RLS for each event, so the filter only
 * narrows what Realtime evaluates: forging it reveals nothing. The topic is
 * unique because removeChannel() is async: a remount (StrictMode, reconnect)
 * reusing the name would get the closing channel back and fail.
 */
export async function subscribeToOrders(
	supabase: SupabaseClient<Database>,
	tenantId: string,
	onChange: () => void,
	onSubscribed?: () => void,
): Promise<RealtimeChannel>
{
	// A session restored from cookies doesn't reach Realtime on its own: without
	// this the channel connects as anon and RLS lets nothing through. Later
	// token refreshes do propagate.
	const { data: { session } } = await supabase.auth.getSession();
	await supabase.realtime.setAuth(session?.access_token ?? null);

	const filter = `tenant_id=eq.${tenantId}`;
	return supabase
		.channel(`orders:${tenantId}:${crypto.randomUUID()}`)
		.on("postgres_changes", { event: "*", schema: "public", table: "orders", filter }, onChange)
		.on("postgres_changes", { event: "*", schema: "public", table: "order_items", filter }, onChange)
		.subscribe((status) =>
		{
			if (status === "SUBSCRIBED")
			{
				onSubscribed?.();
			}
		});
}
