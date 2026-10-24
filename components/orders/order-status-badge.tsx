import { StatusBadge } from "@/components/status-badge";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
	pending: { label: "Pendiente", color: "var(--status-pending)" },
	confirmed: { label: "Confirmado", color: "var(--status-confirmed)" },
	dispatched: { label: "Despachado", color: "var(--status-dispatched)" },
	delivered: { label: "Entregado", color: "var(--status-delivered)" },
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
