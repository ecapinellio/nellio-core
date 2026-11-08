import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
	// Works even if the DTE cron stopped: it reads the backlog, not the cron.
	const { data: backlog } = await supabase.rpc("dte_backlog");
	const stuck = backlog?.filter((r) => r.stuck).length ?? 0;

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Pedidos</h1>
				<p className="hidden text-sm text-muted-foreground md:block">Arrastra una card para cambiar su estado, o usa el botón Confirmar.</p>
			</div>

			{stuck
				? (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertDescription>
							{stuck === 1 ? "1 pedido entregado no tiene" : `${stuck} pedidos entregados no tienen`} factura emitida en Hacienda.{" "}
							<Link href="/orders/facturas" className="font-medium underline underline-offset-4">Revisar</Link>
						</AlertDescription>
					</Alert>
				)
				: null}

			<OrdersPageContent isAdmin={role === "admin"} tenantId={user?.app_metadata.tenant_id ?? ""} />
		</div>
	);
}
