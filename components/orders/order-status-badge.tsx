// DESIGN.md: status is the single most important thing in this system, so
// it gets a left-border + dot treatment, not a tinted-gray badge — it must
// read at a glance under time pressure, not blend in as decoration.
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

	return (
		<span
			className="inline-flex items-center gap-1.5 border-l-[3px] py-0.5 pl-2 text-sm font-semibold"
			style={{ borderColor: config.color }}
		>
			<span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: config.color }} />
			{config.label}
		</span>
	);
}
