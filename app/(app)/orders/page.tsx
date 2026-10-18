import type { Metadata } from "next";
import { OrdersKanban } from "@/components/orders/orders-kanban";

export const metadata: Metadata = {
	title: "Pedidos — Nellio Core",
};

export default function OrdersPage()
{
	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Pedidos</h1>
				<p className="text-sm text-muted-foreground">Arrastra una card para cambiar su estado, o usa el botón Confirmar.</p>
			</div>

			<OrdersKanban />
		</div>
	);
}
