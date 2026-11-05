import { formatOrderTimestamp } from "@/lib/format";
import { eventLabel, reasonLabel } from "@/lib/orders/detail";
import type { OrderDetailEvent } from "@/lib/supabase/queries";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";

/** Who did what and when, oldest first. A correction also says where it went. */
export function OrderTimeline({ events, statuses }: { events: OrderDetailEvent[]; statuses: OrderStatusDef[] })
{
	const label = (key: string) => statuses.find((s) => s.key === key)?.label ?? key;

	return (
		<ol className="flex flex-col gap-3">
			{events.map((e, i) => (
				<li key={i} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
					<span className="text-sm font-medium">
						{eventLabel(e.action)}
						{e.action === "correct" && e.fromStatus ? ` · ${label(e.fromStatus)} → ${label(e.toStatus)}` : null}
					</span>
					<span className="font-mono text-xs tabular-nums text-muted-foreground">
						{formatOrderTimestamp(e.createdAt)}{e.actorName ? ` · ${e.actorName}` : ""}
					</span>
					{e.reason ? <span className="text-xs">Motivo: {reasonLabel(e.reason)}</span> : null}
					{e.note ? <span className="text-xs text-muted-foreground">{e.note}</span> : null}
					{e.withoutSignature ? <span className="text-xs text-muted-foreground">Entregado sin firma</span> : null}
				</li>
			))}
		</ol>
	);
}
