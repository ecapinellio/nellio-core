"use client";

import { useEffect } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { subscribeToOrders } from "@/lib/supabase/orders-live";

// A save touches an order and its lines at once: one refetch for all of it,
// but never more than MAX_WAIT_MS late while events keep coming.
const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 1000;
// A channel the server closed (an expired token, a network drop) doesn't come
// back by itself.
const RETRY_MS = 5000;

/**
 * Runs `refresh` when an order of the tenant changes (ADR-010). The events are
 * only a signal and the board always refetches, so RLS stays the one source of
 * what a user may see. Also refetches on every (re)subscribe: whatever changed
 * while not listening, including during the first load, is caught up.
 * `refresh` must be stable (useCallback).
 */
export function useOrdersLive(supabase: SupabaseClient<Database>, tenantId: string, refresh: () => void): void
{
	useEffect(() =>
	{
		if (!tenantId)
		{
			return;
		}

		let disposed = false;
		let generation = 0;
		let channel: RealtimeChannel | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let firstEventAt = 0;

		function schedule()
		{
			if (disposed)
			{
				return;
			}
			const now = Date.now();
			firstEventAt ||= now;
			clearTimeout(timer);
			timer = setTimeout(() =>
			{
				firstEventAt = 0;
				if (!disposed)
				{
					refresh();
				}
			}, now - firstEventAt >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS);
		}

		function reconnectLater()
		{
			if (disposed || retry)
			{
				return;
			}
			const old = channel;
			channel = undefined;
			generation++;
			if (old)
			{
				supabase.removeChannel(old);
			}
			retry = setTimeout(() =>
			{
				retry = undefined;
				connect();
			}, RETRY_MS);
		}

		function connect()
		{
			const current = ++generation;
			subscribeToOrders(supabase, tenantId, schedule, (status) =>
			{
				if (disposed || current !== generation)
				{
					return;
				}
				if (status === "SUBSCRIBED")
				{
					schedule();
				}
				else
				{
					reconnectLater();
				}
			})
				.then((created) =>
				{
					if (disposed || current !== generation)
					{
						supabase.removeChannel(created);
						return;
					}
					channel = created;
				})
				.catch(reconnectLater);
		}

		connect();

		return () =>
		{
			disposed = true;
			clearTimeout(timer);
			clearTimeout(retry);
			if (channel)
			{
				supabase.removeChannel(channel);
			}
		};
	}, [supabase, tenantId, refresh]);
}
