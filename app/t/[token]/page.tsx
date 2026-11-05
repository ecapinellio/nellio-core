import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { statusColor } from "@/lib/orders/board";
import type { OrderCategory, OrderStep } from "@/lib/orders/fulfillment";
import { formatDeliveryDay, formatLocalTime } from "@/lib/notifications/email";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Seguimiento de pedido" };

interface Tracking
{
	company: string;
	order_ref: string;
	status_label: string;
	category: OrderCategory;
	step: OrderStep | null;
	delivery_date: string | null;
	delivery_window: string | null;
	driver_first_name: string | null;
	delivery: { receiver_name: string | null; delivered_at: string } | null;
	events: { status_label: string; at: string }[];
}

// Public (no login, excluded in proxy.ts): get_order_tracking() returns only
// what the customer may see, or null for an unknown/expired token.
export default async function TrackingPage({ params }: { params: Promise<{ token: string }> })
{
	const { token } = await params;
	const supabase = await createClient();
	const { data, error } = await supabase.rpc("get_order_tracking", { p_token: token });
	if (error)
	{
		throw new Error("No se pudo cargar el pedido.");
	}
	if (!data)
	{
		notFound();
	}
	const t = data as unknown as Tracking;
	const open = t.category === "to_confirm" || t.category === "preparing" || t.category === "in_transit";

	return (
		<main className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-4 py-8">
			<header className="flex flex-col gap-1">
				<p className="text-xs font-medium text-muted-foreground">{t.company}</p>
				<h1 className="text-xl font-semibold">
					Pedido <span className="font-mono tabular-nums">#{t.order_ref}</span>
				</h1>
				<div className="pt-1">
					<StatusBadge label={t.status_label} color={statusColor(t)} />
				</div>
			</header>

			{open && t.delivery_date
				? (
					<section className="flex flex-col gap-1 border-t border-border pt-4">
						<h2 className="text-sm font-semibold">Entrega estimada</h2>
						<p className="text-sm">
							{formatDeliveryDay(t.delivery_date)}{t.delivery_window ? `, ${t.delivery_window}` : ""}
						</p>
						{t.driver_first_name ? <p className="text-sm text-muted-foreground">Te lo lleva {t.driver_first_name}.</p> : null}
					</section>
				)
				: null}

			{t.category === "delivered" && t.delivery
				? (
					<section className="flex flex-col gap-1 border-t border-border pt-4">
						<h2 className="text-sm font-semibold">Entrega</h2>
						<p className="text-sm">
							{t.delivery.receiver_name ? `Lo recibió ${t.delivery.receiver_name} el ` : "Entregado el "}
							<span className="font-mono tabular-nums">{formatLocalTime(t.delivery.delivered_at)}</span>
						</p>
					</section>
				)
				: null}

			<section className="flex flex-col gap-3 border-t border-border pt-4">
				<h2 className="text-sm font-semibold">Historial</h2>
				<ol className="flex flex-col gap-2">
					{[...t.events].reverse().map((e) => (
						<li key={e.at} className="flex items-baseline justify-between gap-4 text-sm">
							<span>{e.status_label}</span>
							<span className="font-mono text-xs tabular-nums text-muted-foreground">{formatLocalTime(e.at)}</span>
						</li>
					))}
				</ol>
			</section>
		</main>
	);
}
