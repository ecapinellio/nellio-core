import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { listOrders } from "@/lib/supabase/queries";
import { OrdersTable } from "@/components/orders/orders-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

export const metadata: Metadata = {
	title: "Mis pedidos — Nellio Core",
};

export default async function OrdersHistorialPage()
{
	const supabase = await createClient();
	const { data, error } = await listOrders(supabase);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Mis pedidos</h1>
				<p className="text-sm text-muted-foreground">Todos los pedidos capturados, del más reciente al más antiguo.</p>
			</div>

			{error
				? (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertDescription>No se pudieron cargar los pedidos. Intenta de nuevo.</AlertDescription>
					</Alert>
				)
				: (
					<OrdersTable initial={data!} />
				)}
		</div>
	);
}
