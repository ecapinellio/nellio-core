import { StatusBadge } from "@/components/status-badge";
import { DEFAULT_STATUSES, statusColor } from "@/lib/orders/board";
import type { OrderStatusDef } from "@/lib/orders/fulfillment";

/**
 * `def` is the tenant's status when the caller has the list (the board);
 * without it the ECTEC defaults name the common keys. A key in neither
 * renders as is rather than failing.
 */
export function OrderStatusBadge({ status, def }: { status: string; def?: OrderStatusDef })
{
	const resolved = def ?? DEFAULT_STATUSES.find((s) => s.key === status);

	if (!resolved)
	{
		return <span className="text-sm text-muted-foreground">{status}</span>;
	}

	return <StatusBadge label={resolved.label} color={statusColor(resolved)} />;
}
