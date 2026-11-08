"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
import { formatOrderTimestamp } from "@/lib/format";
import { OrderDetailPanel } from "@/components/orders/order-detail-panel";

type Row = Database["public"]["Functions"]["dte_backlog"]["Returns"][number];

function statusLabel(r: Row): string
{
	if (r.dte_status === "rejected")
	{
		return "Rechazada por Hacienda";
	}
	if (r.dte_status === "error" || r.invoice_status === "error")
	{
		return "No se pudo emitir";
	}
	if (r.dte_status === "queued")
	{
		return r.stuck ? "Sin respuesta de Hacienda" : "Enviando a Hacienda";
	}
	return "No se envió";
}

/** dte_backlog() rows; a row opens the order, whose Factura block has Reintentar. */
export function InvoiceBacklog({ rows, isAdmin }: { rows: Row[]; isAdmin: boolean })
{
	const router = useRouter();
	const [openOrderId, setOpenOrderId] = useState<string | null>(null);

	if (!rows.length)
	{
		return <p className="text-sm text-muted-foreground">Todo al día: cada pedido entregado tiene su factura emitida.</p>;
	}

	return (
		<>
			<ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
				{rows.map((r) => (
					<li key={r.order_id}>
						<button type="button" onClick={() => setOpenOrderId(r.order_id)}
							className="flex min-h-11 w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
							<span className="flex flex-wrap items-baseline justify-between gap-x-3">
								<span className="font-medium">{r.customer_name ?? "Sin cliente"}</span>
								<span className="text-xs text-muted-foreground tabular-nums">desde {formatOrderTimestamp(r.since)}</span>
							</span>
							<span className={`text-sm ${r.stuck ? "font-medium text-destructive" : "text-muted-foreground"}`}>{statusLabel(r)}</span>
							{r.last_error ? <span className="text-xs text-muted-foreground">{r.last_error}</span> : null}
						</button>
					</li>
				))}
			</ul>
			<OrderDetailPanel
				isAdmin={isAdmin}
				orderId={openOrderId}
				onClose={() =>
				{
					setOpenOrderId(null);
					router.refresh();
				}}
				onSaved={() =>
				{
					setOpenOrderId(null);
					router.refresh();
				}}
			/>
		</>
	);
}
