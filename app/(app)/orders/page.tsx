import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { OrdersPageContent } from "@/components/orders/orders-page-content";

export const metadata: Metadata = {
	title: "Pedidos — Nellio Core",
};

export default async function OrdersPage()
{
	// role from the JWT (app_metadata), same pattern as app/(app)/layout.tsx
	// — never from the users table, per lib/rbac.ts's own convention.
	// Computed here (Server Component), passed down as a plain boolean —
	// OrdersPageContent is where OrderStats/OrdersKanban actually get
	// coordinated (design review Decision 4's "gate before mount" intent
	// preserved, just one level lower since the two siblings now need to
	// share state a Server Component can't hold).
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	const role = user?.app_metadata.role;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Pedidos</h1>
				<p className="text-sm text-muted-foreground">Arrastra una card para cambiar su estado, o usa el botón Confirmar.</p>
			</div>

			<OrdersPageContent isAdmin={role === "admin"} />
		</div>
	);
}
