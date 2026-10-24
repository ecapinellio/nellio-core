// DESIGN.md: status is the single most important thing in this system, so
// it gets a left-border + dot treatment, not a tinted-gray badge — it must
// read at a glance under time pressure, not blend in as decoration. Shared
// by order status and user account status so the two can't drift apart.
export function StatusBadge({ label, color }: { label: string; color: string })
{
	return (
		<span
			className="inline-flex items-center gap-1.5 border-l-[3px] py-0.5 pl-2 text-sm font-semibold"
			style={{ borderColor: color }}
		>
			<span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: color }} />
			{label}
		</span>
	);
}
