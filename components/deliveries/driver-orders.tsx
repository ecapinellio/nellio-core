"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Phone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { listDriverOrders, pickUpOrders, respondToAssignment, type DriverOrder } from "@/lib/orders/actions-client";
import { formatDeliveryDate } from "@/lib/orders/board";
import { describeError, groupDriverOrders } from "@/lib/orders/driver-orders";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";
import { listOrderStatuses } from "@/lib/supabase/queries";
import { useOrdersLive } from "@/hooks/use-orders-live";
import { useRefreshOnReturn } from "@/hooks/use-refresh-on-return";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { OrderStatusBadge } from "@/components/orders/order-status-badge";
import { DeliverySheet } from "@/components/deliveries/delivery-sheet";
import { FailedDeliverySheet } from "@/components/deliveries/failed-delivery-sheet";

interface Settings
{
	require_driver_acceptance: boolean;
	require_signature: boolean;
	require_receiver_name: boolean;
	require_photo: boolean;
}

// Same as the column defaults, for a tenant with no settings row.
const DEFAULT_SETTINGS: Settings = { require_driver_acceptance: true, require_signature: true, require_receiver_name: true, require_photo: false };

type Sheet = { kind: "deliver" | "fail"; order: DriverOrder } | null;

export function DriverOrders({ tenantId }: { tenantId: string })
{
	const supabase = useMemo(() => createClient(), []);
	const [orders, setOrders] = useState<DriverOrder[] | null>(null);
	const [statuses, setStatuses] = useState<OrderStatusDef[]>([]);
	const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
	const [loadError, setLoadError] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [sheet, setSheet] = useState<Sheet>(null);
	const sequence = useRef(0);

	// Every load goes through here (first, Realtime signal, return to the app,
	// reconnect, after an action): the newest response wins (ADR-010).
	const refresh = useCallback(async () =>
	{
		const current = ++sequence.current;
		const [ordersResult, statusResult, settingsResult] = await Promise.all([
			listDriverOrders(supabase),
			listOrderStatuses(supabase),
			supabase.from("tenant_order_settings").select("require_driver_acceptance, require_signature, require_receiver_name, require_photo").maybeSingle(),
		]);
		if (current !== sequence.current)
		{
			return;
		}
		if (ordersResult.error || !ordersResult.data || statusResult.error || !statusResult.data || settingsResult.error)
		{
			setLoadError(true);
			return;
		}
		setLoadError(false);
		setOrders(ordersResult.data);
		setStatuses(statusResult.data);
		setSettings(settingsResult.data ?? DEFAULT_SETTINGS);
	}, [supabase]);

	useEffect(() =>
	{
		const timer = setTimeout(refresh, 0);
		window.addEventListener("online", refresh);
		return () =>
		{
			clearTimeout(timer);
			window.removeEventListener("online", refresh);
		};
	}, [refresh]);
	useRefreshOnReturn(refresh);
	useOrdersLive(supabase, tenantId, refresh);

	async function run(key: string, action: () => Promise<{ error: { code?: string; message: string } | null }>)
	{
		setBusy(key);
		setMessage(null);
		try
		{
			const { error } = await action();
			if (error)
			{
				const described = describeError(error, navigator.onLine);
				setMessage(described.message);
				if (!described.reload)
				{
					return;
				}
			}
			await refresh();
		}
		catch
		{
			setMessage(describeError({ message: "fetch failed" }, navigator.onLine).message);
		}
		finally
		{
			setBusy(null);
		}
	}

	function afterSheet(saved: string | undefined)
	{
		setSheet(null);
		setMessage(saved ?? null);
		refresh();
	}

	if (loadError && !orders)
	{
		return <p className="text-sm text-muted-foreground">No se pudieron cargar tus pedidos. Refresca la página.</p>;
	}
	if (!orders)
	{
		return <p className="text-sm text-muted-foreground">Cargando…</p>;
	}

	const groups = groupDriverOrders(orders, statuses, settings.require_driver_acceptance);
	const empty = orders.length === 0;

	function card(order: DriverOrder, actions?: React.ReactNode, closed = false)
	{
		return <OrderCard key={order.id} order={order} def={statuses.find((s) => s.key === order.status)} actions={actions} closed={closed} />;
	}

	return (
		<div className="flex flex-col gap-6">
			{message
				? (
					<Alert variant="destructive" role="alert">
						<AlertTriangle />
						<AlertDescription>{message}</AlertDescription>
					</Alert>
				)
				: null}
			{loadError ? <p className="text-xs text-muted-foreground">No se pudo actualizar. Mostrando lo último que cargó.</p> : null}
			{empty ? <p className="text-sm text-muted-foreground">Aún no tienes entregas asignadas.</p> : null}

			<Section title="Por aceptar" orders={groups.toAccept}>
				{(order) => card(order, (
					<>
						<ActionButton busy={busy === order.id} disabled={busy !== null} onClick={() => run(order.id, () => respondToAssignment(supabase, order.id, true, order.status))}>Aceptar</ActionButton>
						<ActionButton variant="secondary" busy={false} disabled={busy !== null} onClick={() => run(order.id, () => respondToAssignment(supabase, order.id, false, order.status))}>Rechazar</ActionButton>
					</>
				))}
			</Section>

			<Section
				title="Por recoger"
				orders={groups.toPickUp}
				header={groups.toPickUp.length > 1
					? <ActionButton busy={busy === "all"} disabled={busy !== null} onClick={() => run("all", () => pickUpOrders(supabase, groups.toPickUp.map((o) => o.id)))}>Recoger todos</ActionButton>
					: null}
			>
				{(order) => card(order, (
					<ActionButton busy={busy === order.id} disabled={busy !== null} onClick={() => run(order.id, () => pickUpOrders(supabase, [order.id]))}>Recogido</ActionButton>
				))}
			</Section>

			<Section title="En camino" orders={groups.inTransit}>
				{(order) => card(order, (
					<>
						<ActionButton busy={false} disabled={busy !== null} onClick={() => setSheet({ kind: "deliver", order })}>Entregar</ActionButton>
						<ActionButton variant="secondary" busy={false} disabled={busy !== null} onClick={() => setSheet({ kind: "fail", order })}>No se pudo entregar</ActionButton>
					</>
				))}
			</Section>

			<Section title="Entrega fallida: la oficina la reprograma" orders={groups.failed}>
				{(order) => card(order)}
			</Section>

			<Section title="Cerrados (últimos 7 días)" orders={groups.closed}>
				{(order) => card(order, undefined, true)}
			</Section>

			<DeliverySheet
				order={sheet?.kind === "deliver" ? sheet.order : null}
				settings={settings}
				tenantId={tenantId}
				onSaved={afterSheet}
				onClose={() => setSheet(null)}
			/>
			<FailedDeliverySheet order={sheet?.kind === "fail" ? sheet.order : null} onSaved={afterSheet} onClose={() => setSheet(null)} />
		</div>
	);
}

function Section({ title, orders, header, children }: {
	title: string;
	orders: DriverOrder[];
	header?: React.ReactNode;
	children: (order: DriverOrder) => React.ReactNode;
})
{
	if (orders.length === 0)
	{
		return null;
	}
	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-lg font-semibold">{title} <span className="font-mono text-sm text-muted-foreground tabular-nums">{orders.length}</span></h2>
				{header}
			</div>
			{orders.map(children)}
		</section>
	);
}

function ActionButton({ busy, variant, children, ...props }: React.ComponentProps<typeof Button> & { busy: boolean })
{
	return (
		<Button type="button" variant={variant} className="h-11 flex-1" {...props}>
			{busy ? <Loader2 className="animate-spin" /> : null}
			{children}
		</Button>
	);
}

function OrderCard({ order, def, actions, closed }: { order: DriverOrder; def: OrderStatusDef | undefined; actions?: React.ReactNode; closed: boolean })
{
	const { customer } = order;
	return (
		<article className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
			<div className="flex items-start justify-between gap-3">
				<h3 className="text-base font-semibold">{customer.name}</h3>
				<OrderStatusBadge status={order.status} def={def} />
			</div>
			{customer.address ? <p className="text-sm">{customer.address}</p> : null}
			{customer.phone
				? (
					<a href={`tel:${customer.phone}`} className="inline-flex h-11 items-center gap-2 self-start text-sm font-medium text-primary">
						<Phone className="size-4" />
						<span className="font-mono tabular-nums">{customer.phone}</span>
					</a>
				)
				: null}
			{order.delivery_date
				? <p className="font-mono text-sm tabular-nums">{formatDeliveryDate(order.delivery_date)}{order.delivery_window ? ` · ${order.delivery_window}` : ""}</p>
				: null}
			<ul className="flex flex-col gap-1 text-sm">
				{order.items.map((item) => (
					<li key={item.id} className="flex justify-between gap-3">
						<span>{item.product_name}</span>
						<span className="shrink-0 font-mono tabular-nums">
							{item.delivered_quantity !== null && item.delivered_quantity !== item.quantity ? `${item.delivered_quantity} de ` : ""}{item.quantity}{item.unit ? ` ${item.unit}` : ""}
						</span>
					</li>
				))}
			</ul>
			<p className="flex justify-between border-t border-border pt-2 text-sm">
				<span className="text-muted-foreground">{closed ? "Total entregado" : "Total a cobrar"}</span>
				<span className="font-mono font-semibold tabular-nums">{order.total === null ? "—" : `$${order.total.toFixed(2)}`}</span>
			</p>
			{actions ? <div className="flex gap-2">{actions}</div> : null}
		</article>
	);
}
