"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getTodayStats, type TodayStats } from "@/lib/supabase/queries";

function dayBoundsForNow(): { dayStart: Date; dayEnd: Date }
{
	const now = new Date();
	const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const dayEnd = new Date(dayStart);
	dayEnd.setDate(dayEnd.getDate() + 1);
	return { dayStart, dayEnd };
}

/** No realtime (design review Decision 3) — this is computed once when data loads, not a live-ticking clock. */
function formatRelativeTime(from: Date): string
{
	const seconds = Math.floor((Date.now() - from.getTime()) / 1000);
	if (seconds < 60)
	{
		return "hace unos segundos";
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
	{
		return `hace ${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	return `hace ${hours} h`;
}

interface StatProps
{
	label: string;
	value: string | number;
	suffix?: string | null;
}

function Stat({ label, value, suffix }: StatProps)
{
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="font-mono text-2xl font-bold tabular-nums sm:text-3xl">
				{value}
				{suffix
					? <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">{suffix}</span>
					: null}
			</span>
		</div>
	);
}

/**
 * Admin-only by construction — only mounted by page.tsx when role === "admin"
 * (design review Decision 4: gated server-side, not self-hiding). One flush
 * row (design Decision 1 — no per-stat cards, avoids the "dashboard-card
 * mosaic" anti-pattern DESIGN.md's App UI rules call out), large bold
 * numbers (Decision 2 — the first prominent-number treatment in this app),
 * a single staleness line for the whole row (Decision 3 — all 4 numbers
 * share one fetch timestamp), grid-cols-2 on mobile / grid-cols-4 above sm
 * (Decision 6).
 */
export function OrderStats()
{
	const supabase = useMemo(() => createClient(), []);
	const [stats, setStats] = useState<TodayStats | null>(null);
	const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
	const [loadError, setLoadError] = useState(false);

	useEffect(() =>
	{
		let active = true;
		const { dayStart, dayEnd } = dayBoundsForNow();

		getTodayStats(supabase, dayStart, dayEnd).then(({ data, error }) =>
		{
			if (!active)
			{
				return;
			}
			if (error || !data)
			{
				setLoadError(true);
				return;
			}
			setStats(data);
			setFetchedAt(new Date());
		});

		return () =>
		{
			active = false;
		};
	}, [supabase]);

	if (loadError)
	{
		// The kanban board below still works — a stats fetch failure
		// doesn't block the page (eng-review Failure Modes table).
		return <p className="border-b border-border pb-4 text-sm text-destructive">No se pudieron cargar las estadísticas.</p>;
	}

	if (!stats)
	{
		return <p className="border-b border-border pb-4 text-sm text-muted-foreground">Cargando estadísticas...</p>;
	}

	return (
		<div className="flex flex-col gap-2 border-b border-border pb-4">
			<div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
				<Stat label="Pedidos hoy" value={stats.ordersToday} />
				<Stat label="Pendientes" value={stats.pendingToday} />
				<Stat label="Entregados" value={stats.deliveredToday} />
				<Stat
					label="Ventas"
					value={`$${stats.salesToday.toFixed(2)}`}
					suffix={stats.unpricedCount > 0 ? `+ ${stats.unpricedCount} sin precio` : null}
				/>
			</div>

			{fetchedAt
				? <p className="text-xs text-muted-foreground">actualizado {formatRelativeTime(fetchedAt)}</p>
				: null}
		</div>
	);
}
