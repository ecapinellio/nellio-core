import { StatusBadge } from "@/components/status-badge";
import { ORDER_STATUS_LABELS } from "@/lib/order-math";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
	pending: { label: ORDER_STATUS_LABELS.pending, color: "var(--status-pending)" },
	confirmed: { label: ORDER_STATUS_LABELS.confirmed, color: "var(--status-confirmed)" },
	dispatched: { label: ORDER_STATUS_LABELS.dispatched, color: "var(--status-dispatched)" },
	delivered: { label: ORDER_STATUS_LABELS.delivered, color: "var(--status-delivered)" },
};

export function OrderStatusBadge({ status }: { status: string })
{
	const config = STATUS_CONFIG[status];

	if (!config)
	{
		return <span className="text-sm text-muted-foreground">{status}</span>;
	}

	return <StatusBadge label={config.label} color={config.color} />;
}
