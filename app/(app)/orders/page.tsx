import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { OrdersKanban } from "@/components/orders/orders-kanban";
import { OrderStats } from "@/components/orders/order-stats";

export const metadata: Metadata = {
	title: "Pedidos — Nellio Core",
};

export default async function OrdersPage()
{
	// role from the JWT (app_metadata), same pattern as app/(app)/layout.tsx
	// — never from the users table, per lib/rbac.ts's own convention.
	// Gated HERE, not inside OrderStats (design review Decision 4): a
	// non-admin never even mounts the component, no wasted fetch.
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	const role = user?.app_metadata.role;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Pedidos</h1>
				<p className="text-sm text-muted-foreground">Arrastra una card para cambiar su estado, o usa el botón Confirmar.</p>
			</div>

			{role === "admin" ? <OrderStats /> : null}

			<OrdersKanban />
		</div>
	);
}
