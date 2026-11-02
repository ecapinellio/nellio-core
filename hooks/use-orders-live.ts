"use client";

import { useEffect } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { subscribeToOrders } from "@/lib/supabase/orders-live";

// A save touches an order and its lines at once: one refetch for all of it.
const DEBOUNCE_MS = 300;

/**
 * Runs `refresh` when an order of the tenant changes (ADR-010). The events are
 * only a signal and the board always refetches, so RLS stays the one source of
 * what a user may see. Also refetches after a reconnect: events missed while
 * offline are gone. `refresh` must be stable (useCallback).
 */
export function useOrdersLive(supabase: SupabaseClient<Database>, tenantId: string, refresh: () => void): void
{
	useEffect(() =>
	{
		if (!tenantId)
		{
			return;
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		let connectedBefore = false;

		function schedule()
		{
			clearTimeout(timer);
			timer = setTimeout(refresh, DEBOUNCE_MS);
		}

		const subscription = subscribeToOrders(supabase, tenantId, schedule, () =>
		{
			if (connectedBefore)
			{
				schedule();
			}
			connectedBefore = true;
		});

		return () =>
		{
			clearTimeout(timer);
			subscription.then((channel) => supabase.removeChannel(channel));
		};
	}, [supabase, tenantId, refresh]);
}
