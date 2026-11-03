import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type OrdersChannelStatus = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR";

/**
 * Calls `onChange` when an order of the tenant or one of its lines is created
 * or changed. Realtime checks the subscriber's RLS for INSERT and UPDATE, so
 * the filter only narrows what Realtime evaluates: forging it reveals nothing.
 * DELETE is left out on purpose: Realtime applies neither RLS nor filters to
 * it, so every tenant would hear another tenant's deletes (ADR-010).
 *
 * The topic is unique because removeChannel() is async: a remount reusing the
 * name would get the closing channel back and fail.
 */
export async function subscribeToOrders(
	supabase: SupabaseClient<Database>,
	tenantId: string,
	onChange: () => void,
	onStatus?: (status: OrdersChannelStatus) => void,
): Promise<RealtimeChannel>
{
	// A session restored from cookies doesn't reach Realtime on its own: without
	// this the channel connects as anon and RLS lets nothing through. Later
	// token refreshes do propagate.
	const { data: { session } } = await supabase.auth.getSession();
	await supabase.realtime.setAuth(session?.access_token ?? null);

	const filter = `tenant_id=eq.${tenantId}`;
	let channel = supabase.channel(`orders:${tenantId}:${Math.random().toString(36).slice(2)}`);
	for (const table of ["orders", "order_items"] as const)
	{
		for (const event of ["INSERT", "UPDATE"] as const)
		{
			channel = channel.on("postgres_changes", { event, schema: "public", table, filter }, onChange);
		}
	}
	return channel.subscribe((status) => onStatus?.(status as OrdersChannelStatus));
}
