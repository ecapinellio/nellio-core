"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { listOrders, type ListOrdersResult, type OrderListItem } from "@/lib/supabase/queries";
import { formatChannel } from "@/lib/format";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

function formatCreatedAt(iso: string): string
{
	return new Date(iso).toLocaleString("es-SV", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function OrdersTable({ initial }: { initial: ListOrdersResult })
{
	const supabase = useMemo(() => createClient(), []);

	const [orders, setOrders] = useState<OrderListItem[]>(initial.orders);
	const [cursor, setCursor] = useState(initial.nextCursor);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleLoadMore()
	{
		if (!cursor)
		{
			return;
		}
		setLoadingMore(true);
		setError(null);

		const { data, error: listError } = await listOrders(supabase, { cursor });
		setLoadingMore(false);

		if (listError)
		{
			setError("No se pudo cargar más pedidos. Intenta de nuevo.");
			return;
		}

		setOrders((prev) => [...prev, ...data!.orders]);
		setCursor(data!.nextCursor);
	}

	if (orders.length === 0)
	{
		return (
			<p className="py-12 text-center text-sm text-muted-foreground">
				Todavía no hay pedidos capturados.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Cliente</TableHead>
						<TableHead>Estado</TableHead>
						<TableHead>Canal</TableHead>
						<TableHead className="text-right">Items</TableHead>
						<TableHead className="text-right">Fecha</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{orders.map((order) => (
						<TableRow key={order.id}>
							<TableCell className="font-medium">{order.customerName}</TableCell>
							<TableCell><OrderStatusBadge status={order.status} /></TableCell>
							<TableCell className="text-muted-foreground">{formatChannel(order.channel)}</TableCell>
							<TableCell className="text-right font-mono tabular-nums">{order.itemCount}</TableCell>
							<TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
								{formatCreatedAt(order.createdAt)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>

			{error
				? (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)
				: null}

			{cursor
				? (
					<Button variant="secondary" onClick={handleLoadMore} disabled={loadingMore} className="self-center">
						{loadingMore ? "Cargando..." : "Cargar más"}
					</Button>
				)
				: null}
		</div>
	);
}
