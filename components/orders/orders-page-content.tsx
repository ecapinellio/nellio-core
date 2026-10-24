"use client";

import { useState } from "react";
import { OrderStats } from "@/components/orders/order-stats";
import { OrdersKanban } from "@/components/orders/orders-kanban";

interface OrdersPageContentProps
{
	isAdmin: boolean;
}

/**
 * OrderStats and OrdersKanban are siblings, each with their own fetch —
 * neither knows the other exists. A price edit or a status move in the
 * board has no way to tell OrderStats its numbers are now stale, which is
 * why "ventas"/"pendientes"/etc. only used to update on a full page
 * reload. This client component is the coordination point: it owns a
 * `statsRefreshKey` that OrdersKanban bumps via `onOrderChanged`, which
 * re-runs OrderStats' fetch effect.
 *
 * `isAdmin` still decides here, not inside OrderStats (design review
 * Decision 4's intent preserved) — the check just moved one level down
 * from page.tsx (a Server Component, which can't hold this shared state)
 * to this thin client wrapper. OrderStats still never mounts for a
 * non-admin viewer.
 */
export function OrdersPageContent({ isAdmin }: OrdersPageContentProps)
{
	const [statsRefreshKey, setStatsRefreshKey] = useState(0);

	return (
		<>
			{isAdmin ? <OrderStats refreshKey={statsRefreshKey} /> : null}
			<OrdersKanban onOrderChanged={() => setStatsRefreshKey((key) => key + 1)} />
		</>
	);
}
